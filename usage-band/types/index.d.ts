export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'
// A weekly window scoped to one model, as the usage endpoint names it (`Fable`). `stale` marks a window
// from a reading older than SCOPED_STALE_MS, drawn faded until a new reading comes.
export type Scoped = { label: string; percentUsed: number; resetsAt?: string; stale?: boolean }
// The per-model windows as last read, and when (ms since the epoch); shared by every session
export type ScopedReading = { at: number; limits: Scoped[] }

// Why the last attempt to read the usage endpoint failed, and when: an HTTP status, `no-login`
// (no first-party login to ask with), `shape` (an answer in neither known shape) or the error's text
export type ScopedError = { at: number; status?: number; reason?: string }

/**
 * The `$.usageBand` noun as every caller sees it: read-only, so another mod can show the per-model
 * weekly windows without asking the usage endpoint itself. Where usage-band is not installed there
 * is no `$.usageBand`, so a caller wraps the call in try/catch.
 */
export type UsageBand = {
  /**
   * The per-model weekly windows as last read: `at` is when, in ms since the epoch; `stale` is
   * whether that is more than 30 minutes ago. Each window has `label` (the model's display name,
   * `Fable`), `percentUsed` (0 to 100) and `resetsAt` (ISO 8601). A window whose reset has passed is
   * left out until the next reading. Null before the first reading.
   */
  modelLimits: () => Promise<{ at: number; stale: boolean; limits: { label: string; percentUsed: number; resetsAt?: string }[] } | null>
}

declare module 'claude-code' {
  interface EngineInterface {
    usageBand: UsageBand
  }
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
