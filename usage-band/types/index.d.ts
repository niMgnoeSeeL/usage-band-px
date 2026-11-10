export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'
// A weekly window scoped to one model, as the usage endpoint names it (`Fable`)
export type Scoped = { label: string; percentUsed: number; resetsAt?: string }
// The per-model windows as last read, and when (ms since the epoch); shared by every session
export type ScopedReading = { at: number; limits: Scoped[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      measure: Measure | null
      turn: TurnTokens | null
      now: number
      phase: number
      style: Style
      scoped: ScopedReading | null
      sweep: boolean
    }
  }
}
