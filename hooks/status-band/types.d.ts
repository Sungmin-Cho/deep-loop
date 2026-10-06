// Plugin state contract for the deep-loop status band (Claude Code Mods).
export type DeepLoopBandState = {
  display: unknown
  selected: unknown
  cadence: 'fast' | 'slow' | 'off'
  tick: number
} | null

declare module 'claude-code' {
  interface PluginState {
    'deep-loop': { band: DeepLoopBandState; hidden: boolean }
  }
}
