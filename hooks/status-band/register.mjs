// Claude Code status band mod (issue #75): a read-only line above the prompt.
// It only ever runs `deep-loop.mjs run status --json` and never mutates loop state.
// `$` is never stored or passed: capability closures are built in `session.start`
// (`caps`) and every orchestration function below uses `caps` only.
import { atom, read, update } from 'claude-code'
import {
  FALLBACK_INTERVAL_MS, REFRESH_DEBOUNCE_MS, RUN_TIMEOUT_MS,
  applyCompletionProbe, bandModel, busyToast, copyOutcomeToast, fillOutcomeToast, fillPlan,
  isDeepLoopCommand, needsCompletionProbe, nextBandState, parseStatus, shouldPoll, statusArgv, transitions,
} from './band.mjs'

const bandAtom = atom({ plugin: 'deep-loop', key: 'band' }, null)
const hiddenAtom = atom({ plugin: 'deep-loop', key: 'hidden' }, false)

let caps = null
let active = false
// Starts at a per-load random value, not 0: `$.state` survives a hot reload, so a band the previous
// module instance published must not look current to this one before its first refresh.
let generation = Math.floor(Math.random() * 2 ** 40)
let inFlight = false
let dirty = false
let debounce = null
let fallback = null

// An unhandled rejection in a timer callback or a Button handler fails the host.
const guard = (fn) => async (...args) => {
  try { await fn(...args) } catch { /* the band is best-effort */ }
}

async function run(c, argv, processCwd) {
  try {
    const r = await c.run(argv, { cwd: processCwd, timeoutMs: RUN_TIMEOUT_MS })
    if (r?.isStdoutTruncated) return { error: new Error('stdout truncated') }
    return { exitCode: r.exitCode, stdout: r.stdout }
  } catch (error) {
    return { error: error ?? new Error('run failed') }
  }
}

function deactivate() {
  active = false
  generation += 1
  fallback?.cancel()
  fallback = null
  debounce?.cancel()
  debounce = null
  dirty = false
}

function schedule() {
  if (!caps || !active) return
  debounce?.cancel()
  debounce = caps.after(REFRESH_DEBOUNCE_MS, guard(refresh))
}

async function refresh() {
  if (!caps || !active) return
  if (inFlight) { dirty = true; return }
  inFlight = true
  const c = caps
  const gen = generation
  const live = () => active && gen === generation
  try {
    const pluginRoot = c.pluginRoot
    const cwd = await c.cwd()
    const sessionRoot = await c.sessionRoot()
    if (!live()) return
    const parsed = parseStatus(await run(c, statusArgv(pluginRoot, cwd), sessionRoot))
    const prev = await c.readBand()
    let next = nextBandState(prev, parsed)
    const probeRunId = needsCompletionProbe(prev?.selected ?? null, parsed)
    if (probeRunId && live()) {
      const probed = parseStatus(await run(c, statusArgv(pluginRoot, cwd, probeRunId), sessionRoot))
      next = applyCompletionProbe(next, { prevSelected: prev?.selected ?? null, probeRunId }, probed)
    }
    // A previous observation from an older generation (a detach in between) seeds the completion probe
    // above but never a toast: nothing is announced across a detach boundary.
    const toasts = prev?.gen === gen ? transitions(prev.selected, next.selected) : []
    if (!live()) return
    // The updater refuses stale work, and every published state carries the generation it was computed
    // under: a write that still commits after a detach (and a re-attach) is dropped by the render gate.
    await c.writeBand((s) => (live() ? { ...next, tick: s?.tick ?? next.tick, gen } : s))
    if (!live()) return
    // One toast per refresh: several in one tick draw only the last.
    if (toasts.length) c.toast(toasts.join(' · '))
  } finally {
    inFlight = false
    if (dirty && active) { dirty = false; schedule() }
  }
}

async function activate() {
  const c = caps
  if (!c) return
  const gen = generation
  const surfaces = await c.surfaces()
  if (gen !== generation) return // a detach ran meanwhile and queued its own re-check
  active = surfaces.some((s) => s === 'terminal' || s === 'desktop')
  if (!active) { deactivate(); return }
  fallback ??= c.every(FALLBACK_INTERVAL_MS, guard(onTick))
  await refresh()
}

async function onTick() {
  const c = caps
  if (!c || !active) return
  await c.writeBand((s) => s && { ...s, tick: s.tick + 1 })
  const s = await c.readBand()
  if (shouldPoll(s?.cadence ?? 'slow', s?.tick ?? 0)) await refresh()
}

async function onButton(b, surface) {
  const c = caps
  if (!c) return
  if (b.key === 'hide') { await c.setHidden(true); return }
  if (!b.command) return
  const box = await c.readPrompt()
  if (fillPlan(box?.text) === 'busy') { c.toast(busyToast(b.command)); return }
  const r = await c.fill({ text: `${b.command} `, mode: 'insert' })
  if (r?.isFilled) return
  if (r?.refusal === 'no_composer') {
    const copied = await c.copy({ text: b.command, surface })
    c.toast(copyOutcomeToast(b.command, copied?.isCopied === true))
    return
  }
  c.toast(fillOutcomeToast(b.command, false, r?.refusal))
}

/** @type {import('claude-code').Register} */
export const register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      caps = {
        pluginRoot: $.plugin.root,
        surfaces: () => $.session.surfaces(),
        cwd: () => $.session.cwd(),
        sessionRoot: () => $.session.root(),
        run: (argv, init) => $.process.run(argv, init),
        after: (ms, fn) => $.clock.after(ms, fn),
        every: (ms, fn) => $.clock.every(ms, fn),
        readBand: () => read($, bandAtom),
        writeBand: (fn) => update($, bandAtom, fn),
        setHidden: (v) => update($, hiddenAtom, () => v),
        toast: (text) => $.ui.toast(text),
        readPrompt: () => $.prompt.read(),
        fill: (input) => $.prompt.fill(input),
        copy: (input) => $.ui.copy(input),
      }
      caps.after(1, guard(activate))
    } catch { /* never block session start */ }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    try { caps?.after(1, guard(activate)) } catch { /* best-effort */ }
    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    try {
      deactivate() // immediately: no new child process may start while the re-check is pending
      caps?.after(1, guard(activate))
    } catch { /* best-effort */ }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try { schedule() } catch { /* best-effort */ }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    try { if (isDeepLoopCommand(e.command)) schedule() } catch { /* best-effort */ }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      const band = await read($, bandAtom)
      const hidden = await read($, hiddenAtom)
      const model = bandModel(band?.display ?? null, {
        hidden, hasSurvey: e.props.hasSurvey, active, stale: band?.gen !== generation,
      })
      if (model) {
        const { Box, Text, Button } = $.ui.resolve(e)
        return h(Box, { width: e.props.bodyColumns, flexDirection: 'row', gap: 1 },
          h(Box, { flexGrow: 1, flexShrink: 1, minWidth: 0 },
            h(Text, { dimColor: true, wrap: 'truncate-end' }, model.line)),
          ...model.buttons.map((b) => h(Button, {
            key: b.key, label: b.label, plain: true, onPress: guard(() => onButton(b, e.surface)),
          })))
      }
    } catch { /* draw nothing */ }
    return next(e)
  })
}
