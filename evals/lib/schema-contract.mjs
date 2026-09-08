import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProfile, validateResult, validateTask } from './validate.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const files = { task: 'eval-task.schema.json', result: 'eval-result.schema.json', profile: 'eval-profile.schema.json' };
const runtime = { task: validateTask, result: validateResult, profile: validateProfile };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`SCHEMA_REF_UNSUPPORTED:${ref}`);
  return ref.slice(2).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, token) => value?.[token], root);
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function check(schema, value, root, path, errors) {
  if (schema === true || schema === undefined) return true;
  if (schema === false) { errors.push(`${path}:false-schema`); return false; }
  if (schema.$ref) return check(resolveRef(root, schema.$ref), value, root, path, errors);
  let ok = true;
  const sub = candidate => { const nested = []; return { passed: check(candidate, value, root, path, nested), nested }; };
  if (schema.allOf) for (const item of schema.allOf) { const result = sub(item); if (!result.passed) { ok = false; errors.push(...result.nested); } }
  if (schema.anyOf && !schema.anyOf.map(sub).some(item => item.passed)) { ok = false; errors.push(`${path}:anyOf`); }
  if (schema.oneOf) {
    const matches = schema.oneOf.map(sub).filter(item => item.passed).length;
    if (matches !== 1) { ok = false; errors.push(`${path}:oneOf:${matches}`); }
  }
  if (schema.not && sub(schema.not).passed) { ok = false; errors.push(`${path}:not`); }
  if (schema.if) {
    const branch = sub(schema.if).passed ? schema.then : schema.else;
    if (branch) { const result = sub(branch); if (!result.passed) { ok = false; errors.push(...result.nested); } }
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) { errors.push(`${path}:type`); return false; }
  }
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const)) { ok = false; errors.push(`${path}:const`); }
  if (schema.enum && !schema.enum.some(item => same(value, item))) { ok = false; errors.push(`${path}:enum`); }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) { ok = false; errors.push(`${path}:minLength`); }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) { ok = false; errors.push(`${path}:maxLength`); }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) { ok = false; errors.push(`${path}:pattern`); }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) { ok = false; errors.push(`${path}:minimum`); }
    if (schema.maximum !== undefined && value > schema.maximum) { ok = false; errors.push(`${path}:maximum`); }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) { ok = false; errors.push(`${path}:minItems`); }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) { ok = false; errors.push(`${path}:maxItems`); }
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) { ok = false; errors.push(`${path}:uniqueItems`); }
    if (schema.prefixItems) schema.prefixItems.forEach((item, index) => {
      if (index < value.length && !check(item, value[index], root, `${path}/${index}`, errors)) ok = false;
    });
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) => {
      if (!check(schema.items, item, root, `${path}/${index}`, errors)) ok = false;
    });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) for (const key of schema.required) if (!Object.hasOwn(value, key)) { ok = false; errors.push(`${path}/${key}:required`); }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) { ok = false; errors.push(`${path}:minProperties`); }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) { ok = false; errors.push(`${path}:maxProperties`); }
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) {
        if (!check(properties[key], item, root, `${path}/${key}`, errors)) ok = false;
      } else if (schema.additionalProperties === false) { ok = false; errors.push(`${path}/${key}:additionalProperties`); }
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object'
        && !check(schema.additionalProperties, item, root, `${path}/${key}`, errors)) ok = false;
    }
    if (schema.propertyNames) for (const key of Object.keys(value)) if (!check(schema.propertyNames, key, root, `${path}/<key>`, errors)) ok = false;
  }
  return ok;
}

export function validateJsonSchemaOnly(kind, value) {
  if (!files[kind]) return { ok: false, code: 'SCHEMA_KIND' };
  const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', files[kind]), 'utf8'));
  const errors = [];
  if (!check(schema, value, schema, '#', errors)) return { ok: false, code: 'JSON_SCHEMA', errors };
  return { ok: true, value };
}

export function validatePublishedSchema(kind, value) {
  const schemaOnly = validateJsonSchemaOnly(kind, value);
  if (!schemaOnly.ok) return schemaOnly;
  const semantic = runtime[kind](value);
  return semantic.ok ? { ok: true, value } : { ...semantic, errors: [semantic.code] };
}

export function validateSchemaValue(schema,value) {
 const errors=[];return {ok:check(schema,value,schema,'#',errors),errors};
}
