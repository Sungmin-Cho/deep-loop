import { test, expect, mock } from 'claude-code/testing'

type Surface = 'terminal' | 'desktop'
const SURFACES = ['terminal', 'desktop'] as const
const RUN_ID = '01M27FTBNWNK8XAC63E28X63M3'

const resolution = (over: Record<string, unknown> = {}) => ({ kind: 'selected', source: 'single-active', reason: null, total: null, candidates: [], ...over })
const runBody = (over: Record<string, unknown> = {}) => ({
  run_id: RUN_ID, status: 'running', pause_reason: null,
  budget: { spent: 41, total: 200, tokens_spent: 1, tokens_total: 2, state: 'ok', reason: 'ok' },
  comprehension: { debt_ratio: 0.5, debt_threshold: 0.5, blocked: false },
  pending_human_reviews: 0,
  breaker: { tripped: false, reason: null },
  workstreams: { total: 5, terminal: 2, by_status: { merged: 2, planned: 3 } },
  next_action: { type: 'dispatch_maker', reason: null, next_command: '/deep-loop-continue', blocked_by: [] },
  ...over,
})
const running = (over: Record<string, unknown> = {}) => ({ exitCode: 0, stdout: JSON.stringify({ status_version: 1, ok: true, resolution: resolution(), run: runBody(over) }) + '\n' })
const none = () => ({ exitCode: 0, stdout: JSON.stringify({ status_version: 1, ok: true, resolution: resolution({ kind: 'none', source: null, reason: 'no-runs' }), run: null }) + '\n' })
const invalid = () => ({ exitCode: 1, stdout: JSON.stringify({ status_version: 1, ok: false, resolution: resolution({ kind: 'invalid', source: null, reason: 'run-set-integrity' }), run: null }) + '\n' })
const ambiguous = (reason = 'multi-active-root-cwd', total = 2) => ({ exitCode: 1, stdout: JSON.stringify({ status_version: 1, ok: false, resolution: resolution({ kind: 'ambiguous', source: null, reason, total, candidates: [] }), run: null }) + '\n' })
const failure = () => ({ exitCode: 2, stdout: '' })

const BAND = (cols: number, hasSurvey = false) => ({
  component: 'AbovePrompt',
  props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: cols, scroll: { bodyRows: 9, top: 0, rows: 0 }, view: {} },
}) as const

const MINUTE = 60_000

// One rig per test: every bottom hook is registered before the first `$` call and each event once.
function rig($: any, on: any, surface: Surface, init: { surfaces?: string[] } = {}) {
  const clock = mock.clock(on, { now: 0 })
  const calls: string[][] = []
  const inits: any[] = []
  const toasts: string[] = []
  const fills: string[] = []
  const copies: string[] = []
  let submits = 0
  const ctl: any = {
    surfaces: init.surfaces ?? [surface],
    draft: '',
    fill: { isFilled: true, text: '', cursor: 0 },
    primary: running() as { exitCode: number; stdout: string },
    byRun: {} as Record<string, { exitCode: number; stdout: string }>,
    gate: null as null | Promise<void>,
  }
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId }))
  on('session.detach', (_$: any, e: any) => ({ clientId: e.clientId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' } as never, () => ({ result: { stdout: '', stderr: '', interrupted: false }, isError: false } as never))
  on('prompt.submit', (_$: any, e: any) => { submits += 1; return e })
  on('session.surfaces', () => ({ value: ctl.surfaces }))
  on('session.cwd', () => ({ value: '/proj/sub' }))
  on('session.root', () => ({ value: '/proj' }))
  on('process.run', async (_$: any, e: any) => {
    calls.push([...e.argv])
    inits.push(e.init)
    if (ctl.gate) await ctl.gate
    const i = e.argv.indexOf('--run-id')
    const r = i >= 0 ? (ctl.byRun[e.argv[i + 1]] ?? failure()) : ctl.primary
    return { value: { ...r, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', () => ({ value: { text: ctl.draft, cursor: ctl.draft.length } }))
  on('prompt.fill', (_$: any, e: any) => { fills.push(e.text); return ctl.fill })
  on('ui.copy', (_$: any, e: any) => { copies.push(e.text); return { value: { isCopied: true } } })
  on('ui.render', (t$: any, e: any) => h(t$.ui.resolve(e).Box, {}) as never)
  on('ui.toast', (_$: any, e: any) => { toasts.push(e.text); return { value: undefined } })

  const start = async () => {
    await $.session.start({ cwd: '/proj/sub', surface: null, isInteractive: false })
    await clock.advance(1)
  }
  const draw = async (cols = 120, hasSurvey = false) => {
    const ui = await $.ui.mount({ plugin: 'deep-loop', surface, ...BAND(cols, hasSurvey) } as never)
    const texts = (await ui.findAll({ type: 'Text' })).map((n: any) => String(n.text ?? ''))
    const buttons = (await ui.findAll({ type: 'Button' })).map((n: any) => String(n.props?.label ?? n.label ?? n.text ?? ''))
    return { ui, texts, buttons, line: texts.join('') }
  }
  const shown = async (cols = 120) => {
    const v = await draw(cols)
    await v.ui.unmount()
    return v
  }
  const turn = async () => {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  }
  const detach = () => $.session.detach({ surface, clientId: `${surface}:default`, reason: 'detached' } as never)
  const attach = () => $.session.attach({ surface, clientId: `${surface}:default` } as never)
  const primaryCalls = () => calls.filter((a) => !a.includes('--run-id')).length
  const probeCalls = () => calls.filter((a) => a.includes('--run-id')).length
  return { clock, calls, inits, toasts, fills, copies, ctl, start, draw, shown, turn, detach, attach, primaryCalls, probeCalls, submits: () => submits }
}

for (const surface of SURFACES) {
  test(`renders the running band, argv and child cwd (${surface})`, async ($, on) => {
    const r = rig($, on, surface)
    r.ctl.primary = running({ pending_human_reviews: 2, breaker: { tripped: true, reason: 'consecutive-request-changes' } })
    await r.start()
    expect(r.calls.length).toBe(1)
    expect(r.calls[0][0]).toBe('node')
    expect(r.calls[0][1].endsWith('/scripts/deep-loop.mjs')).toBe(true)
    expect(r.calls[0].slice(2)).toEqual(['run', 'status', '--json', '--cwd', '/proj/sub'])
    expect(r.inits[0].cwd).toBe('/proj')
    expect(r.inits[0].timeoutMs).toBe(5000)
    const v = await r.shown()
    expect(v.line).toContain('loop 63M3 · running · breaker: consecutive-request-changes · budget 41/200 turns · debt 0.50/0.5 · review 2 pending · ws 2/5 · next: dispatch_maker')
    expect(v.buttons).toEqual(['Status', 'Ack', 'Hide'])
  })

  test(`narrow bodyColumns keeps every button and only truncates text (${surface})`, async ($, on) => {
    const r = rig($, on, surface)
    r.ctl.primary = running({ pending_human_reviews: 1 })
    await r.start()
    const v = await r.shown(40)
    expect(v.buttons).toEqual(['Status', 'Ack', 'Hide'])
    expect(v.line).toContain('loop 63M3')
  })

  test(`draws nothing for survey, none, invalid, failure and terminal runs (${surface})`, async ($, on) => {
    const r = rig($, on, surface)
    await r.start()
    expect((await r.shown()).line).toContain('loop 63M3')
    const survey = await r.draw(120, true)
    expect(survey.texts.join('')).not.toContain('loop')
    await survey.ui.unmount()
    for (const reply of [none(), invalid(), failure(), running({ status: 'completed' }), running({ status: 'stopped' })]) {
      r.ctl.primary = reply
      await r.turn()
      await r.clock.advance(1500)
      const v = await r.shown()
      expect(v.line).not.toContain('loop 63M3')
      expect(v.buttons).toEqual([])
      // a run row after a non-drawing reply must come back
      r.ctl.primary = running()
      await r.turn()
      await r.clock.advance(1500)
      expect((await r.shown()).line).toContain('loop 63M3')
    }
  })

  test(`ambiguous replies draw the two fixed sentences with a Status button (${surface})`, async ($, on) => {
    const r = rig($, on, surface)
    r.ctl.primary = ambiguous('multi-active-root-cwd', 3)
    await r.start()
    let v = await r.shown()
    expect(v.line).toContain('deep-loop · 3 active runs · /deep-loop-status')
    expect(v.buttons).toEqual(['Status'])
    r.ctl.primary = ambiguous('duplicate-worktree-claim', 2)
    await r.turn()
    await r.clock.advance(1500)
    v = await r.shown()
    expect(v.line).toContain('deep-loop · worktree claimed by 2 runs · /deep-loop-status')
  })

  test(`Hide, Status fill (insert, no submit), busy prompt and refused fill (${surface})`, async ($, on) => {
    const r = rig($, on, surface)
    r.ctl.primary = running({ pending_human_reviews: 1 })
    await r.start()
    let v = await r.draw()
    r.ctl.fill = { isFilled: true, text: '/deep-loop-status ', cursor: 18 }
    await v.ui.press({ key: 'status' })
    expect(r.fills).toEqual(['/deep-loop-status '])
    expect(r.toasts).toEqual([])
    r.ctl.draft = 'half typed'
    await v.ui.press({ key: 'ack' })
    expect(r.fills).toEqual(['/deep-loop-status '])
    expect(r.toasts).toEqual(['Clear the prompt to insert /deep-loop-ack'])
    r.ctl.draft = ''
    r.ctl.fill = { isFilled: false, text: '', cursor: 0 }
    await v.ui.press({ key: 'ack' })
    expect(r.fills).toEqual(['/deep-loop-status ', '/deep-loop-ack '])
    expect(r.toasts[1]).toBe('Type /deep-loop-ack in the prompt')
    expect(r.submits()).toBe(0)
    await v.ui.press({ key: 'hide' })
    await v.ui.unmount()
    v = await r.draw()
    expect(v.line).not.toContain('loop 63M3')
    await v.ui.unmount()
  })
}

test('nothing is drawn before activation, and a surface-less start activates on a later attach', async ($, on) => {
  const r = rig($, on, 'desktop', { surfaces: [] })
  expect((await r.shown()).line).not.toContain('loop')
  await r.start()
  expect(r.calls.length).toBe(0)
  expect((await r.shown()).line).not.toContain('loop')
  r.ctl.surfaces = ['desktop']
  await r.attach()
  await r.clock.advance(1)
  expect(r.calls.length).toBe(1)
  expect((await r.shown()).line).toContain('loop 63M3')
})

test('Bash deep-loop commands trigger one debounced refresh; other commands do not', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  expect(r.calls.length).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
  await r.clock.advance(2000)
  expect(r.calls.length).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'node /x/scripts/deep-loop.mjs pause --run-id A' } as never)
  await r.clock.advance(1000)
  await $.tool.call({ tool: 'Bash', command: 'node /x/scripts/deep-loop.mjs breaker check' } as never)
  await r.clock.advance(1499)
  expect(r.calls.length).toBe(1)
  await r.clock.advance(1)
  expect(r.calls.length).toBe(2)
})

test('single flight: a refresh during an in-flight one runs once more afterwards', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  let release: () => void = () => {}
  r.ctl.gate = new Promise<void>((resolve) => { release = resolve })
  await r.turn()
  await r.clock.advance(1500)
  expect(r.calls.length).toBe(2)
  await r.turn()
  await r.clock.advance(1500)
  await r.turn()
  await r.clock.advance(1500)
  expect(r.calls.length).toBe(2)
  r.ctl.gate = null
  release()
  await r.clock.advance(1500)
  expect(r.calls.length).toBe(3)
})

test('cadence: fast polls every tick, slow every fifth, off never; failure recovers without local events', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  expect(r.calls.length).toBe(1)
  await r.clock.advance(MINUTE)
  await r.clock.advance(MINUTE)
  expect(r.calls.length).toBe(3)
  // paused -> slow: the tick counter keeps running, a slow cadence polls when tick % 5 === 0
  r.ctl.primary = running({ status: 'paused', pause_reason: 'budget' })
  await r.clock.advance(MINUTE) // tick 3, still fast
  expect(r.calls.length).toBe(4)
  expect((await r.shown()).line).toContain('paused (budget)')
  await r.clock.advance(MINUTE) // tick 4
  expect(r.calls.length).toBe(4)
  await r.clock.advance(MINUTE) // tick 5
  expect(r.calls.length).toBe(5)
  // none -> off (the vanished run is read once by id: its completion is observed and latched)
  r.ctl.primary = none()
  r.ctl.byRun[RUN_ID] = running({ status: 'stopped' })
  await r.clock.advance(4 * MINUTE) // ticks 6..9
  expect(r.calls.length).toBe(5)
  await r.clock.advance(MINUTE) // tick 10: primary + completion read
  expect(r.calls.length).toBe(7)
  expect(r.toasts).toEqual(['deep-loop: run 63M3 stopped'])
  await r.clock.advance(20 * MINUTE)
  expect(r.calls.length).toBe(7)
  // a local event wakes it again, and a failure afterwards recovers on the slow cadence
  r.ctl.primary = failure()
  await r.turn()
  await r.clock.advance(1500)
  expect(r.calls.length).toBe(8)
  r.ctl.primary = running()
  await r.clock.advance(10 * MINUTE)
  expect(r.calls.length).toBeGreaterThan(8)
  expect((await r.shown()).line).toContain('loop 63M3')
})

test('first call failure stays slow and recovers on its own', async ($, on) => {
  const r = rig($, on, 'desktop')
  r.ctl.primary = failure()
  await r.start()
  expect((await r.shown()).line).not.toContain('loop')
  r.ctl.primary = running()
  await r.clock.advance(10 * MINUTE)
  expect((await r.shown()).line).toContain('loop 63M3')
})

test('detach then re-attach keeps exactly one fallback timer', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  const before = r.calls.length
  await r.detach()
  await r.clock.advance(1)
  expect(r.calls.length).toBe(before + 1)
  await r.attach()
  await r.clock.advance(1)
  const afterAttach = r.calls.length
  await r.clock.advance(MINUTE)
  expect(r.calls.length - afterAttach).toBe(1)
})

test('detach with no surface left stops everything: no timer, no refresh', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  const before = r.calls.length
  r.ctl.surfaces = []
  await r.detach()
  await r.clock.advance(10 * MINUTE)
  expect(r.calls.length).toBe(before)
  expect((await r.shown()).line).not.toContain('loop')
})

test('detach just before the debounce deadline never starts a child', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  const before = r.calls.length
  await r.turn()
  await r.clock.advance(1499)
  r.ctl.surfaces = []
  await r.detach()
  await r.clock.advance(5000)
  expect(r.calls.length).toBe(before)
})

test('detach while the primary read is pending: no probe, no state write', async ($, on) => {
  const r = rig($, on, 'terminal')
  r.ctl.byRun[RUN_ID] = running({ status: 'completed' })
  await r.start()
  expect((await r.shown()).line).toContain('loop 63M3')
  let release: () => void = () => {}
  r.ctl.gate = new Promise<void>((resolve) => { release = resolve })
  r.ctl.primary = none()
  await r.turn()
  await r.clock.advance(1500)
  const inFlight = r.calls.length
  r.ctl.surfaces = []
  await r.detach()
  r.ctl.gate = null
  release()
  await r.clock.advance(0)
  expect(r.calls.length).toBe(inFlight)
  expect(r.probeCalls()).toBe(0)
  expect(r.toasts).toEqual([])
  await r.clock.advance(5000)
  expect(r.probeCalls()).toBe(0)
})

test('transitions merge into one toast per refresh', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  r.ctl.primary = running({
    breaker: { tripped: true, reason: 'consecutive-request-changes' },
    comprehension: { debt_ratio: 1, debt_threshold: 0.5, blocked: true },
    budget: { spent: 160, total: 200, tokens_spent: 1, tokens_total: 2, state: 'soft-stop', reason: 'soft-stop-demote' },
  })
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts).toEqual([
    'deep-loop: breaker tripped (consecutive-request-changes) · deep-loop: comprehension debt is blocking new work — /deep-loop-ack · deep-loop: budget soft-stop',
  ])
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts.length).toBe(1)
})

test('completion while still selected toasts once', async ($, on) => {
  const r = rig($, on, 'desktop')
  await r.start()
  r.ctl.primary = running({ status: 'completed' })
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts).toEqual(['deep-loop: run 63M3 completed'])
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts.length).toBe(1)
  expect((await r.shown()).line).not.toContain('loop 63M3')
})

test('completion observed after the run leaves the selection: one toast, then latched with no re-read', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  r.ctl.byRun[RUN_ID] = running({ status: 'stopped' })
  r.ctl.primary = ambiguous()
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts).toEqual(['deep-loop: run 63M3 stopped'])
  expect(r.probeCalls()).toBe(1)
  for (const reply of [ambiguous(), none(), ambiguous()]) {
    r.ctl.primary = reply
    await r.turn()
    await r.clock.advance(1500)
  }
  expect(r.toasts.length).toBe(1)
  expect(r.probeCalls()).toBe(1)
})

test('failed completion read keeps the run and recovers on a slow tick without local events', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  r.ctl.primary = none()
  await r.turn()
  await r.clock.advance(1500)
  expect(r.probeCalls()).toBe(1)
  expect(r.toasts).toEqual([])
  r.ctl.byRun[RUN_ID] = running({ status: 'completed' })
  await r.clock.advance(10 * MINUTE)
  expect(r.toasts).toEqual(['deep-loop: run 63M3 completed'])
})

test('primary Y with a non-terminal probe of X keeps tracking X until it completes', async ($, on) => {
  const r = rig($, on, 'terminal')
  await r.start()
  const Y = '01YYYYYYYYYYYYYYYYYYYYYYYY'
  r.ctl.primary = running({ run_id: Y })
  r.ctl.byRun[RUN_ID] = running()
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts).toEqual([])
  expect((await r.shown()).line).toContain('loop YYYY')
  r.ctl.byRun[RUN_ID] = running({ status: 'completed' })
  await r.turn()
  await r.clock.advance(1500)
  expect(r.toasts).toEqual(['deep-loop: run 63M3 completed'])
})
