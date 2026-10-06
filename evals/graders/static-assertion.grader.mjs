import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN_ROUTE = /['"](?:push|pr|merge|publish|delete|sync)['"]\s*,?/i;
const PROCESS_CALLS = new Set(['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork']);
const NETWORK_CALLS = new Set(['fetch']);
const NETWORK_MEMBERS = new Set(['request', 'get']);

// Claude Code Mods host calls: `$.process.run(argv)`, `$.process.spawn({ argv })`, `$.http.fetch(url, init)`.
// Only the last two member segments are judged, so a hook may receive the engine under any name.
function modHostCall(segments) {
  if (!Array.isArray(segments) || segments.length < 3) return null;
  const tail = segments.slice(-2).join('.');
  if (tail === 'process.run' || tail === 'process.spawn') return 'process';
  if (tail === 'http.fetch') return 'network';
  return null;
}

function tokens(source) {
  const output = [];
  let line = 1;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '\n') { line += 1; index += 1; continue; }
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2); index = end < 0 ? source.length : end; continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += (source.slice(index, stop).match(/\n/g) || []).length;
      index = stop; continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char; const startLine = line; let value = ''; index += 1;
      while (index < source.length) {
        if (source[index] === '\n') line += 1;
        if (source[index] === '\\') { value += source[index + 1] || ''; index += 2; continue; }
        if (source[index] === quote) { index += 1; break; }
        value += source[index]; index += 1;
      }
      output.push({ type: 'string', value, line: startLine }); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      output.push({ type: 'identifier', value: source.slice(index, end), line }); index = end; continue;
    }
    const pair = source.slice(index, index + 2);
    if (['=>', '==', '===', '!=', '!=='].includes(pair)) {
      output.push({ type: 'punct', value: pair, line }); index += 2; continue;
    }
    output.push({ type: 'punct', value: char, line }); index += 1;
  }
  return output;
}

function matching(stream, start, open = '(', close = ')') {
  let depth = 0;
  for (let index = start; index < stream.length; index += 1) {
    if (stream[index].value === open) depth += 1;
    else if (stream[index].value === close && --depth === 0) return index;
  }
  return stream.length - 1;
}

function memberPathAt(stream, start) {
  if (stream[start]?.type !== 'identifier') return null;
  const segments = [stream[start].value];
  let next = start + 1;
  for (;;) {
    // `?.` is tokenised as `?` then `.`: both spellings are member separators.
    const dot = stream[next]?.value === '.' ? next : (stream[next]?.value === '?' && stream[next + 1]?.value === '.' ? next + 1 : -1);
    if (dot < 0 || stream[dot + 1]?.type !== 'identifier') break;
    segments.push(stream[dot + 1].value);
    next = dot + 2;
  }
  // `x?.(` is a call: point `next` at the `(`.
  if (stream[next]?.value === '?' && stream[next + 1]?.value === '.' && stream[next + 2]?.value === '(') next += 2;
  return { segments, next };
}

function expressionWords(items, constants) {
  const words = [];
  let joined = '';
  const flush = () => { if (joined) { words.push(joined.toLowerCase()); joined = ''; } };
  for (const token of items) {
    if (token.type === 'string') { joined += token.value; continue; }
    if (token.value === '+') continue;
    flush();
    if (token.type === 'identifier' && constants.has(token.value)) words.push(...constants.get(token.value));
  }
  flush();
  return words.flatMap(word => word.split(/[^a-z0-9-]+/).filter(Boolean));
}

function assignedExpressions(stream) {
  const constants = new Map();
  for (let index = 0; index < stream.length - 3; index += 1) {
    if (!['const', 'let', 'var'].includes(stream[index].value) || stream[index + 1]?.type !== 'identifier'
      || stream[index + 2]?.value !== '=') continue;
    let end = index + 3;
    while (end < stream.length && stream[end].value !== ';' && stream[end].value !== '\n') end += 1;
    const expression = stream.slice(index + 3, end);
    if (!expression.some(token => token.value === '=>')) constants.set(stream[index + 1].value, expressionWords(expression, constants));
  }
  return constants;
}

function callableSurface(stream) {
  const processAliases = new Set(PROCESS_CALLS);
  const networkAliases = new Set(NETWORK_CALLS);
  const processNamespaces = new Set();
  const networkNamespaces = new Set(['http', 'https']);
  const processObjectAliases = new Map();
  const networkObjectAliases = new Map([['globalThis', new Set(['fetch'])]]);
  // Mods: `const p = $.process` (namespace alias) and wrapper property names (`{ run: (a) => $.process.run(a) }`).
  const hostNamespaces = { process: new Set(), network: new Set() };
  const hostMembers = { process: new Set(['run', 'spawn']), network: new Set(['fetch']) };
  const memberNames = { process: new Set(), network: new Set() };
  const objectMember = (map, object, member) => {
    if (!map.has(object)) map.set(object, new Set());
    const before = map.get(object).size;
    map.get(object).add(member);
    return map.get(object).size !== before;
  };
  const addCallablePath = (aliases, objects, path) => {
    const segments = typeof path === 'string' ? path.split('.') : path;
    if (segments.length === 1) {
      const before = aliases.size;
      aliases.add(segments[0]);
      return aliases.size !== before;
    }
    return objectMember(objects, segments.slice(0, -1).join('.'), segments.at(-1));
  };
  const allObjectPaths = objects => [...objects.entries()]
    .flatMap(([object, members]) => [...members].map(member => `${object}.${member}`));
  const hasObjectPrefix = (objects, path) => allObjectPaths(objects)
    .some(candidate => candidate.startsWith(`${path}.`));
  const copyObjectPaths = (objects, source, target) => {
    let copied = false;
    for (const candidate of allObjectPaths(objects)) {
      if (!candidate.startsWith(`${source}.`)) continue;
      copied = addCallablePath(new Set(), objects, `${target}${candidate.slice(source.length)}`) || copied;
    }
    return copied;
  };
  const isCallablePath = (segments, aliases, namespaces, members, objects, kind) => {
    if (modHostCall(segments) === kind) return true;
    if (segments.length === 2 && hostNamespaces[kind]?.has(segments[0]) && hostMembers[kind]?.has(segments[1])) return true;
    // Recorded wrapper member names count here exactly as in the final call check (`hostCall`).
    if (segments.length >= 2 && memberNames[kind]?.has(segments.at(-1))) return true;
    if (segments.length === 1) return aliases.has(segments[0]);
    if (segments.length === 2 && namespaces.has(segments[0]) && members.has(segments[1])) return true;
    return objects.get(segments.slice(0, -1).join('.'))?.has(segments.at(-1)) === true;
  };
  const moduleAfter = index => {
    const from = stream.findIndex((token, cursor) => cursor > index && cursor < index + 40 && token.value === 'from');
    return from >= 0 && stream[from + 1]?.type === 'string' ? stream[from + 1].value : '';
  };
  for (let index = 0; index < stream.length; index += 1) {
    if (stream[index].value !== 'import') continue;
    const module = moduleAfter(index);
    const processModule = module === 'node:child_process';
    const networkModule = module === 'node:http' || module === 'node:https';
    if (stream[index + 1]?.value === '*') {
      const local = stream[index + 2]?.value === 'as' ? stream[index + 3]?.value : null;
      if (local && processModule) processNamespaces.add(local);
      if (local && networkModule) networkNamespaces.add(local);
    }
    if (stream[index + 1]?.type === 'identifier') {
      const local = stream[index + 1].value;
      if (processModule) processNamespaces.add(local);
      if (networkModule) networkNamespaces.add(local);
    }
    if (stream[index + 1]?.value !== '{') continue;
    for (let cursor = index + 2; cursor < stream.length && stream[cursor].value !== '}'; cursor += 1) {
      const imported = stream[cursor].value;
      const local = stream[cursor + 1]?.value === 'as' ? stream[cursor + 2]?.value : imported;
      if (processModule && PROCESS_CALLS.has(imported)) processAliases.add(local);
      if (networkModule && NETWORK_MEMBERS.has(imported)) networkAliases.add(local);
    }
  }

  const functions = [];
  const objectLiterals = [];
  // End of an expression-bodied arrow: `;`, the closer of an enclosing group, or a line break at depth 0
  // where neither side requires the expression to continue. A line break is not a boundary after an
  // operator / opening bracket / `=>` / prefix keyword, nor before `.`, `?.`, `(`, `[`, an operator, `,` or a
  // closer. When in doubt the scan continues: a false positive is caught by the real-repo assertion, a false
  // negative would be silent.
  const CONTINUES_AFTER = new Set(['&&', '||', '??', '?', ':', '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
    '+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', ',', '.', '?.', '(', '[', '{', '=>', '!', '~',
    'await', 'return', 'typeof', 'void', 'delete', 'new', 'yield', 'in', 'of', 'instanceof']);
  const CONTINUES_BEFORE = new Set(['.', '?.', '(', '[', '&&', '||', '??', '?', ':', '=', '==', '===', '!=', '!==', '<', '>',
    '<=', '>=', '+', '-', '*', '/', '%', '**', '&', '|', '^', ',', ')', ']', '}', 'in', 'of', 'instanceof']);
  const continuesAfter = token => token.type !== 'string' && CONTINUES_AFTER.has(token.value);
  const continuesBefore = token => token.type !== 'string' && CONTINUES_BEFORE.has(token.value);
  const statementEnd = start => {
    let depth = 0;
    for (let cursor = start; cursor < stream.length; cursor += 1) {
      const value = stream[cursor].value;
      const punct = stream[cursor].type === 'punct';
      if (punct && (value === '(' || value === '[' || value === '{')) depth += 1;
      else if (punct && (value === ')' || value === ']' || value === '}')) { if (depth === 0) return cursor - 1; depth -= 1; }
      else if (punct && depth === 0 && value === ';') return cursor;
      const next = stream[cursor + 1];
      if (depth === 0 && next && next.line > stream[cursor].line
        && !continuesAfter(stream[cursor]) && !continuesBefore(next)) return cursor;
    }
    return stream.length - 1;
  };

  const expressionEnd = (start, limit) => {
    const depths = { '(': 0, '[': 0, '{': 0 };
    const closes = { ')': '(', ']': '[', '}': '{' };
    for (let cursor = start; cursor < limit; cursor += 1) {
      const value = stream[cursor].value;
      if (Object.hasOwn(depths, value)) depths[value] += 1;
      else if (Object.hasOwn(closes, value)) depths[closes[value]] -= 1;
      else if (value === ',' && Object.values(depths).every(depth => depth === 0)) return cursor;
    }
    return limit;
  };
  const collectObject = (owner, start, end) => {
    objectLiterals.push({ owner, start, end });
    for (let cursor = start + 1; cursor < end;) {
      if (stream[cursor]?.type !== 'identifier') { cursor += 1; continue; }
      const property = stream[cursor].value;
      if (stream[cursor + 1]?.value === ':') {
        const valueStart = cursor + 2;
        const valueEnd = expressionEnd(valueStart, end);
        if (stream[valueStart]?.value === '{') {
          const nestedEnd = matching(stream, valueStart, '{', '}');
          collectObject(`${owner}.${property}`, valueStart, nestedEnd);
        } else {
          const arrow = stream.findIndex((token, index) => index >= valueStart && index < valueEnd && token.value === '=>');
          if (arrow >= 0) {
            const bodyStart = arrow + 1;
            const bodyEnd = stream[bodyStart]?.value === '{' ? matching(stream, bodyStart, '{', '}') : valueEnd;
            functions.push({ name: `${owner}.${property}`, body: stream.slice(bodyStart, bodyEnd + 1) });
          }
        }
        cursor = Math.max(valueEnd + 1, cursor + 2);
        continue;
      }
      if (stream[cursor + 1]?.value === '(') {
        const parametersEnd = matching(stream, cursor + 1);
        if (stream[parametersEnd + 1]?.value === '{') {
          const bodyEnd = matching(stream, parametersEnd + 1, '{', '}');
          functions.push({ name: `${owner}.${property}`, body: stream.slice(parametersEnd + 1, bodyEnd + 1) });
          cursor = bodyEnd + 1;
          continue;
        }
      }
      cursor += 1;
    }
  };
  for (let index = 0; index < stream.length; index += 1) {
    let name; let bodyStart; let bodyEnd;
    if (stream[index].value === 'function' && stream[index + 1]?.type === 'identifier') {
      name = stream[index + 1].value;
      bodyStart = stream.findIndex((token, cursor) => cursor > index + 1 && token.value === '{');
      bodyEnd = bodyStart >= 0 ? matching(stream, bodyStart, '{', '}') : -1;
    } else if (['const', 'let', 'var'].includes(stream[index].value) && stream[index + 1]?.type === 'identifier'
      && stream[index + 2]?.value === '=' && stream[index + 3]?.value !== '{') {
      const arrow = stream.findIndex((token, cursor) => cursor > index + 2 && cursor < index + 20 && token.value === '=>');
      if (arrow >= 0) {
        name = stream[index + 1].value; bodyStart = arrow + 1;
        bodyEnd = stream[bodyStart]?.value === '{' ? matching(stream, bodyStart, '{', '}')
          : statementEnd(bodyStart);
      }
    }
    if (name && bodyStart >= 0 && bodyEnd >= bodyStart) functions.push({ name, body: stream.slice(bodyStart, bodyEnd + 1) });
    if (stream[index]?.type === 'identifier' && stream[index + 1]?.value === '=' && stream[index + 2]?.value === '{') {
      const end = matching(stream, index + 2, '{', '}');
      collectObject(stream[index].value, index + 2, end);
    }
  }

  const hasDirect = (body, aliases, namespaces, members, objects, kind) => body.some((token, index) => {
    if (token.type !== 'identifier') return false;
    const call = memberPathAt(body, index);
    return body[call.next]?.value === '(' && isCallablePath(call.segments, aliases, namespaces, members, objects, kind);
  });

  const propagateObject = ({ owner, start, end }, aliases, namespaces, members, objects, kind) => {
    let propagated = false;
    for (let cursor = start + 1; cursor < end;) {
      if (stream[cursor]?.type !== 'identifier') { cursor += 1; continue; }
      const property = stream[cursor].value;
      if (stream[cursor + 1]?.value !== ':') { cursor += 1; continue; }
      const valueStart = cursor + 2;
      const valueEnd = expressionEnd(valueStart, end);
      if (stream[valueStart]?.value !== '{') {
        const target = memberPathAt(stream, valueStart);
        if (target && target.next <= valueEnd) {
          if (isCallablePath(target.segments, aliases, namespaces, members, objects, kind)) {
            propagated = addCallablePath(aliases, objects, `${owner}.${property}`) || propagated;
          }
          const targetPath = target.segments.join('.');
          if (hasObjectPrefix(objects, targetPath)) {
            propagated = copyObjectPaths(objects, targetPath, `${owner}.${property}`) || propagated;
          }
        }
      }
      cursor = Math.max(valueEnd + 1, cursor + 2);
    }
    return propagated;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < stream.length; index += 1) {
      if (stream[index]?.type !== 'identifier' || stream[index + 1]?.value !== '='
        || stream[index - 1]?.value === '.') continue;
      const name = stream[index].value;
      const target = memberPathAt(stream, index + 2);
      if (target) {
        if (isCallablePath(target.segments, processAliases, processNamespaces, PROCESS_CALLS, processObjectAliases, 'process')) {
          changed = addCallablePath(processAliases, processObjectAliases, name) || changed;
        }
        if (isCallablePath(target.segments, networkAliases, networkNamespaces, NETWORK_MEMBERS, networkObjectAliases, 'network')) {
          changed = addCallablePath(networkAliases, networkObjectAliases, name) || changed;
        }
        if (target.segments.length >= 2 && stream[target.next]?.value !== '(') {
          const last = target.segments.at(-1);
          const kindOf = last === 'process' ? 'process' : (last === 'http' ? 'network' : null);
          if (kindOf && !hostNamespaces[kindOf].has(name)) { hostNamespaces[kindOf].add(name); changed = true; }
        }
        const targetPath = target.segments.join('.');
        if (hasObjectPrefix(processObjectAliases, targetPath)) changed = copyObjectPaths(processObjectAliases, targetPath, name) || changed;
        if (hasObjectPrefix(networkObjectAliases, targetPath)) changed = copyObjectPaths(networkObjectAliases, targetPath, name) || changed;
      }
      if (stream[index + 2]?.value === 'promisify' && stream[index + 3]?.value === '('
        && processAliases.has(stream[index + 4]?.value)) {
        changed = addCallablePath(processAliases, processObjectAliases, name) || changed;
      }
    }
    for (const object of objectLiterals) {
      changed = propagateObject(object, processAliases, processNamespaces, PROCESS_CALLS, processObjectAliases, 'process') || changed;
      changed = propagateObject(object, networkAliases, networkNamespaces, NETWORK_MEMBERS, networkObjectAliases, 'network') || changed;
    }
    for (const helper of functions) {
      if (helper.name.includes('.')) {
        const member = helper.name.split('.').at(-1);
        if (hasDirect(helper.body, processAliases, processNamespaces, PROCESS_CALLS, processObjectAliases, 'process')
          && !memberNames.process.has(member)) { memberNames.process.add(member); changed = true; }
        if (hasDirect(helper.body, networkAliases, networkNamespaces, NETWORK_MEMBERS, networkObjectAliases, 'network')
          && !memberNames.network.has(member)) { memberNames.network.add(member); changed = true; }
      }
      if (hasDirect(helper.body, processAliases, processNamespaces, PROCESS_CALLS, processObjectAliases, 'process')
        ) changed = addCallablePath(processAliases, processObjectAliases, helper.name) || changed;
      if (hasDirect(helper.body, networkAliases, networkNamespaces, NETWORK_MEMBERS, networkObjectAliases, 'network')
        ) changed = addCallablePath(networkAliases, networkObjectAliases, helper.name) || changed;
    }
  }
  return {
    processAliases, networkAliases, processNamespaces, networkNamespaces,
    processObjectAliases, networkObjectAliases, hostNamespaces, hostMembers, memberNames,
  };
}

function routeFromWords(words) {
  const has = value => words.includes(value);
  if (has('git') && has('push')) return 'git push';
  if (has('gh') && has('pr')) return 'gh pr';
  for (const action of ['merge', 'publish', 'delete']) if (has(action)) return action;
  if ((has('marketplace') || has('deep-suite')) && has('sync')) return 'sync';
  return null;
}

function networkRoute(words) {
  const has = value => words.includes(value);
  const mutating = ['post','put','patch','delete','create','merge','publish'].some(has);
  if (!mutating) return null;
  if ((has('pulls') || has('pull-request') || has('pullrequests')) && (has('post') || has('create'))) {
    return 'network api:pull-request';
  }
  if (has('merge')) return 'merge';
  if (has('publish') || has('releases')) return 'publish';
  if (has('delete')) return 'delete';
  if ((has('marketplace') || has('deep-suite')) && has('sync')) return 'sync';
  return 'network-write';
}

// Mods namespace aliases (`const p = $.process; p.run(...)`) and wrapper member names recorded for this file
// (any `<x>.<name>(` / `<x>?.<name>(` once `<name>` was seen to wrap a host call).
// Known gaps: destructured `({ process }) => process.run(...)` (a bare `process.run` is not judged, because
// Node's own `process` global would make that a false positive) and wrappers built with computed keys.
function hostCall(surface, segments, kind) {
  if (segments.length < 2) return false;
  if (segments.length === 2 && surface.hostNamespaces[kind].has(segments[0]) && surface.hostMembers[kind].has(segments[1])) return true;
  return surface.memberNames[kind].has(segments.at(-1));
}

export function findExecutableExternalActions(source, { path = '<source>', structured = false } = {}) {
  const stream = tokens(source);
  const constants = assignedExpressions(stream);
  const surface = callableSurface(stream);
  const found = [];
  for (let index = 0; index < stream.length - 1; index += 1) {
    const call = memberPathAt(stream, index);
    if (!call || stream[call.next]?.value !== '(') continue;
    const processCall = (call.segments.length === 1
      ? surface.processAliases.has(call.segments[0])
      : (call.segments.length === 2 && surface.processNamespaces.has(call.segments[0]) && PROCESS_CALLS.has(call.segments[1]))
        || surface.processObjectAliases.get(call.segments.slice(0, -1).join('.'))?.has(call.segments.at(-1)))
      || modHostCall(call.segments) === 'process'
      || hostCall(surface, call.segments, 'process');
    const networkCall = (call.segments.length === 1
      ? surface.networkAliases.has(call.segments[0])
      : (call.segments.length === 2 && surface.networkNamespaces.has(call.segments[0]) && NETWORK_MEMBERS.has(call.segments[1]))
        || surface.networkObjectAliases.get(call.segments.slice(0, -1).join('.'))?.has(call.segments.at(-1)))
      || modHostCall(call.segments) === 'network'
      || hostCall(surface, call.segments, 'network');
    if (!processCall && !networkCall) continue;
    const open = call.next;
    const end = matching(stream, open);
    const words = expressionWords(stream.slice(open + 1, end), constants);
    const route = networkCall ? networkRoute(words) : routeFromWords(words);
    if (route) found.push({ path, line: stream[index].line, route });
  }
  const unique = [...new Map(found.map(item => [`${item.path}:${item.line}:${item.route}`, item])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.route.localeCompare(right.route));
  return structured ? unique : [...new Set(unique.map(item => item.route))].sort();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function walkFiles(root, rel) {
  const absolute = join(root, rel);
  if (!existsSync(absolute)) return [];
  const output = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) output.push(...walkFiles(root, child));
    else if (entry.isFile()) output.push(child);
    else throw new Error(`unsupported-production-surface:${child}`);
  }
  return output;
}

export function productionSurfaceInventory(root) {
  const surfaces = ['scripts/deep-loop.mjs'];
  for (const rel of [
    'scripts/hooks-impl', 'scripts/lib', 'scripts/workers', 'hooks', 'protocols', 'recipes',
    '.claude-plugin', '.codex-plugin',
  ]) surfaces.push(...walkFiles(root, rel));
  const skillsRoot = join(root, 'skills');
  if (!existsSync(skillsRoot)) throw new Error('production-surface-missing:skills');
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name.startsWith('deep-loop')) {
      surfaces.push(...walkFiles(root, `skills/${entry.name}`));
    }
  }
  return [...new Set(surfaces)].sort();
}

export function gradeStaticAssertion(assertionId, root) {
  if (assertionId !== 'no-external-action-routes') return { observation_class: 'unexpected_failure', pass: false, reason: 'unknown-assertion' };
  try {
    const cliPath = join(root, 'scripts', 'deep-loop.mjs');
    const hooksPath = join(root, 'hooks', 'hooks.json');
    const cli = readFileSync(cliPath, 'utf8');
    const hooks = readFileSync(hooksPath, 'utf8');
    const inventory = cli.match(/const MUTATING_ROUTE_INVENTORY\s*=\s*Object\.freeze\(\[[\s\S]*?\]\);/)?.[0];
    if (!inventory) return { observation_class: 'unexpected_failure', pass: false, reason: 'inventory-missing' };
    const surfacePaths = productionSurfaceInventory(root);
    const surfaces = surfacePaths.map(path => [path, readFileSync(join(root, path), 'utf8')]);
    const surfaceBytes = surfaces.map(([path, source]) => `${path}\0${Buffer.byteLength(source)}\0${source}`).join('\0');
    const skills = surfaces.filter(([path]) => path.startsWith('skills/')).map(([, source]) => source).join('\n');
    const violations = surfaces.flatMap(([path, source]) => findExecutableExternalActions(source, {
      path, structured: true,
    }));
    if (FORBIDDEN_ROUTE.test(inventory)) violations.push({ path: 'scripts/deep-loop.mjs', line: 1, route: 'forbidden inventory route' });
    const unique = [...new Map(violations.map(item => [`${item.path}:${item.line}:${item.route}`, item])).values()]
      .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.route.localeCompare(right.route));
    const forbidden = unique.length > 0;
    return {
      observation_class: forbidden ? 'expected_success' : 'expected_gate', pass: !forbidden,
      evidence: {
        production_surfaces: surfacePaths,
        production_surface_sha256: sha256(surfaceBytes),
        inventory_sha256: sha256(inventory), hooks_sha256: sha256(hooks), skills_sha256: sha256(skills),
        violations: unique,
      },
    };
  } catch (error) {
    return { observation_class: 'unexpected_failure', pass: false, reason: error.message };
  }
}
