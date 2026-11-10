// The fork's own behaviour: the per-model weekly windows from the usage endpoint, the VS Code row
// in the box above the prompt, and how the row stacks with the rows of the hooks beneath it.
import { expect, mock, test } from 'claude-code/testing'

import {
  EDITOR_LOOKS,
  SCOPED_EVERY_MS,
  SCOPED_URL,
  SPACE,
  editorSvg,
  modelsAt,
  oklch,
  parseScoped,
} from '../hooks/register'
import type { Measure, TurnTokens } from '../types'

const NOW = Date.parse('2026-11-10T12:00:00Z')
const MIN = 60_000
const RESET = new Date(NOW + (4 * 24 + 6) * 3_600_000 + 20 * MIN).toISOString()
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as never,
} as const
const START = { source: 'startup', cwd: '/repo', surface: 'vscode', isInteractive: true } as never
const MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 17.6 },
  rateLimits: [{ kind: 'seven_day', percentUsed: 43, resetsAt: RESET }],
}
const TURN: TurnTokens = { input: 2_000, output: 3_000, cacheRead: 97_000, cacheWrite: 1_000 }
const FABLE = [{ label: 'Fable', percentUsed: 20, resetsAt: RESET }]

// The endpoint's answer: its `limits` rows, as Claude Code 2.1.322 reads them for /usage
const body = (percent = 20, resets: unknown = RESET.replace('Z', '712+00:00')) =>
  JSON.stringify({
    five_hour: null,
    seven_day: { utilization: 43, resets_at: RESET },
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 43, resets_at: RESET, scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent, resets_at: resets, scope: { model: { display_name: 'Fable' } } },
    ],
  })

type On = Parameters<typeof mock.clock>[0]
const world = (on: On, store: Map<string, unknown>, answer: () => { status: number; text: string }, login = true) => {
  const asked: { url: string; auth?: string }[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: MEASURE.context, rateLimits: MEASURE.rateLimits } }))
  on('session.authorize', () => ({ value: login ? { handle: 'h1', kind: 'bearer' } : null }))
  on('http.fetch', ($, e) => {
    asked.push({ url: e.url, auth: e.init?.auth })
    const { status, text } = answer()
    return { value: { status, ok: status >= 200 && status < 300, headers: {}, text } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  return asked
}

test('reads the per-model weekly windows in either shape the usage answer comes in', async () => {
  expect(parseScoped(JSON.parse(body()))).toEqual([{ label: 'Fable', percentUsed: 20, resetsAt: RESET }])
  // Claude Code's SDK projection of the same rows
  expect(parseScoped({ model_scoped: [{ display_name: 'Fable', utilization: 20.5, resets_at: RESET }] })).toEqual([
    { label: 'Fable', percentUsed: 20.5, resetsAt: RESET },
  ])
  // Epoch seconds, as the rate-limit headers write them
  expect(parseScoped({ limits: [{ kind: 'weekly_scoped', percent: 1, resets_at: Date.parse(RESET) / 1000, scope: { model: { display_name: 'Fable' } } }] })?.[0]?.resetsAt).toBe(RESET)
  // An account with no per-model window, and rows that are not one
  expect(parseScoped({ limits: [{ kind: 'weekly_all', percent: 5, scope: null }, { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Fable' } } }] })).toEqual([])
  // An answer in another shape says nothing
  expect(parseScoped({ error: 'rate_limited' })).toBe(null)
  expect(parseScoped('text')).toBe(null)
})

test('asks the endpoint at most once per five minutes across sessions, and shares the reading', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['welcomed', true]])
  const asked = world(on, store, () => ({ status: 200, text: body() }))
  await $.session.start(START)
  await clock.settle()
  expect(asked).toEqual([{ url: SCOPED_URL, auth: 'h1' }])
  expect(store.get('scoped-tried')).toBe(NOW)
  expect(store.get('scoped')).toEqual({ at: NOW, limits: [{ label: 'Fable', percentUsed: 20, resetsAt: RESET }] })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', ...BAND })
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe(
    '7-day limit 43% used, Fable 7-day limit 20% used, context 176K of 1M',
  )

  // The minute ticks inside the five minutes ask nothing
  await clock.advance(4 * MIN)
  await clock.settle()
  expect(asked.length).toBe(1)

  // Another session asked a minute ago: this one takes its reading and asks nothing
  store.set('scoped-tried', NOW + 4 * MIN)
  store.set('scoped', { at: NOW + 4 * MIN, limits: [{ label: 'Fable', percentUsed: 24, resetsAt: RESET }] })
  await clock.advance(2 * MIN)
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(String((await ui.find({ type: 'Svg' }))?.props.alt)).toContain('Fable 7-day limit 24% used')

  // Five minutes after that session's attempt, this one asks
  await clock.advance(SCOPED_EVERY_MS)
  await clock.settle()
  expect(asked.length).toBe(2)
  await ui.unmount()
})

test('with no first-party login it asks nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['welcomed', true]])
  const asked = world(on, store, () => ({ status: 200, text: body() }), false)
  await $.session.start(START)
  await clock.settle()
  expect(asked).toEqual([])
  expect(store.has('scoped-tried')).toBe(false)
})

test('a refused request keeps the reading and is not repeated within five minutes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['welcomed', true]])
  const asked = world(on, store, () => ({ status: 429, text: '{"error":"rate_limited"}' }))
  await $.session.start(START)
  await clock.settle()
  await clock.advance(3 * MIN)
  await clock.settle()
  expect(asked.length).toBe(1)
  expect(store.has('scoped')).toBe(false)
  await clock.advance(2 * MIN)
  await clock.settle()
  expect(asked.length).toBe(2)
})

test('a stale reading, or a window that has reset since, is not drawn', async () => {
  const reading = { at: NOW, limits: FABLE }
  expect(modelsAt(reading, NOW + 10 * MIN)).toEqual(FABLE)
  expect(modelsAt(reading, NOW + 31 * MIN)).toEqual([])
  expect(modelsAt({ at: NOW, limits: [{ label: 'Fable', percentUsed: 20, resetsAt: new Date(NOW + MIN).toISOString() }] }, NOW + 2 * MIN)).toEqual([])
  expect(modelsAt(null, NOW)).toEqual([])
})

// ---- The VS Code row

test('VS Code draws one SVG that fills the row, worked out from the theme text color', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, new Map<string, unknown>([['welcomed', true]]), () => ({ status: 200, text: body() }))
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', ...BAND })
  const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  // A percent width and no viewBox: the webview draws it at the row's width and nothing scales
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100%" height="13">/)
  expect(svg).not.toContain('viewBox')
  // The webview's frame follows the system's scheme, not the editor's theme: no scheme query
  expect(svg).not.toContain('prefers-color-scheme')
  expect(svg).toContain('currentColor')
  // The terminal's 200ms redraw never starts in VS Code
  await clock.advance(1_000)
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toBe(svg)
  await ui.unmount()
})

test('each tier fits the width that shows it, the last a 280px panel', async () => {
  const at = NOW
  for (const look of EDITOR_LOOKS) {
    const { svg, widths } = editorSvg(MEASURE, TURN, at, FABLE, look)
    for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThan(widths[i - 1]!)
    // A 280px panel leaves 262px inside the frame's border and padding
    expect(widths[widths.length - 1]!).toBeLessThanOrEqual(262)
    // 640px leaves 622: the full tier, with bars and reset times
    expect(widths[0]!).toBeLessThanOrEqual(622)
    expect(svg).toContain(`@media (max-width:${widths[0]! - 0.02}px){.v0{display:none}.v1{display:inline}}`)
    // The bars and the reset time are in the full tier
    expect(svg).toContain('4d6h')
  }
})

test('looks differ in hue and motion: A always shines, B once after a change, C never', async () => {
  const a = editorSvg(MEASURE, TURN, NOW, FABLE, 'A').svg
  const bFresh = editorSvg(MEASURE, TURN, NOW, FABLE, 'B', true).svg
  const bStill = editorSvg(MEASURE, TURN, NOW, FABLE, 'B', false).svg
  const c = editorSvg(MEASURE, TURN, NOW, FABLE, 'C').svg
  expect(a).toContain('linear infinite')
  expect(bFresh).toContain('linear 1"')
  expect(bFresh).not.toContain('infinite')
  // The webview reads `animation:` as a moving picture and draws it frame by frame
  for (const still of [bStill, c]) expect(still).not.toMatch(/<animate|animation(?:-[a-z-]{1,24})?\s*:(?!\s*none\b)/)
  // Motion stops under prefers-reduced-motion (CHECKLIST #13)
  for (const moving of [a, bFresh]) expect(moving).toContain('@media (prefers-reduced-motion:reduce){.sh{animation:none!important}}')
  // A tints the figures; B and C draw them in the text color
  expect(a).toMatch(/class="n" style="fill:oklch\(from currentColor l/)
  expect(bStill).not.toMatch(/class="n" style=/)
  // C's bars and dots are the one accent (savvy-progress's band); B's keep each metric's hue (7d, Fable, context)
  const hues = (s: string) => new Set([...s.matchAll(/class="bar" style="fill:oklch\(from currentColor calc\([^)]*\) [\d.]+ ([\d.]+)\)/g)].map(m => m[1]))
  expect(hues(c).size).toBe(1)
  expect(hues(bStill).size).toBe(3)
})

test('a metric in trouble turns its figure and bar red in every look', async () => {
  const hot: Measure = { ...MEASURE, rateLimits: [{ kind: 'seven_day', percentUsed: 85, resetsAt: RESET }] }
  const red = oklch('#e5685f')[2].toFixed(3)
  for (const look of EDITOR_LOOKS) {
    const { svg } = editorSvg(hot, TURN, NOW, [], look)
    expect(svg).toContain(`style="fill:oklch(from currentColor l 0.09 ${+red})"`)
    expect(svg).toMatch(new RegExp(`class="bar" style="fill:oklch\\(from currentColor calc\\([^)]*\\) [\\d.]+ ${+red}\\)`))
  }
})

// The colors the webview works out, against VS Code's themes: the preview's light and dark, and
// Light (Visual Studio), the theme this machine uses (text #616161 on #f3f3f3)
const THEMES = [
  { text: '#3b3b3b', bg: '#f8f8f8' },
  { text: '#cccccc', bg: '#1f1f1f' },
  { text: '#616161', bg: '#f3f3f3' },
]
const fromOklch = (L: number, C: number, H: number): string => {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614601 * s]
  const enc = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)))
  return `#${lin.map(v => enc(v).toString(16).padStart(2, '0')).join('')}`
}
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
}
const ratio = (x: string, y: string) => {
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}

test('figures keep 4.5:1 and bars 3:1, against the background and their track, in every theme', async () => {
  for (const look of EDITOR_LOOKS) {
    const hot: Measure = { ...MEASURE, rateLimits: [{ kind: 'seven_day', percentUsed: 85, resetsAt: RESET }] }
    const svg = editorSvg(MEASURE, TURN, NOW, FABLE, look).svg + editorSvg(hot, { ...TURN, cacheRead: 100 }, NOW, FABLE, look).svg
    const figures = [...svg.matchAll(/fill:oklch\(from currentColor l ([\d.]+) ([\d.]+)\)/g)].map(m => [+m[1]!, +m[2]!] as const)
    const bars = [...svg.matchAll(/fill:oklch\(from currentColor calc\(([\d.]+) \+ ([\d.]+) \* l\) ([\d.]+) ([\d.]+)\)/g)].map(m => [+m[1]!, +m[2]!, +m[3]!, +m[4]!] as const)
    if (look !== 'A') expect(figures.length).toBeGreaterThan(0) // the red ones
    expect(bars.length).toBeGreaterThan(0)
    for (const { text, bg } of THEMES) {
      const L = oklch(text)[0]
      for (const [c, h] of figures) expect(ratio(fromOklch(L, c, h), bg)).toBeGreaterThanOrEqual(4.5)
      for (const [l0, k, c, h] of bars) {
        const fill = fromOklch(l0 + k * L, c, h)
        expect(ratio(fill, bg)).toBeGreaterThanOrEqual(3)
        // The track is the fill at 22% over the background
        const n = (x: string, i: number) => parseInt(x.slice(1 + 2 * i, 3 + 2 * i), 16)
        const track = `#${[0, 1, 2].map(i => Math.round(0.22 * n(fill, i) + 0.78 * n(bg, i)).toString(16).padStart(2, '0')).join('')}`
        expect(ratio(fill, track)).toBeGreaterThanOrEqual(3)
      }
      // Muted text: currentColor mixed a quarter toward grey
      const mute = `#${[0, 1, 2].map(i => Math.round(0.75 * parseInt(text.slice(1 + 2 * i, 3 + 2 * i), 16) + 0.25 * 0x88).toString(16).padStart(2, '0')).join('')}`
      expect(ratio(mute, bg)).toBeGreaterThanOrEqual(4.5)
    }
  }
})

// ---- Stacking (layout/ABOVE-PROMPT.md, C1 and C2)

const ROW = { type: 'Box', props: { flexDirection: 'row' }, children: [{ type: 'Text', props: {}, children: ['fold'] }] }
const SPACED = { type: 'Box', props: { flexDirection: 'column', paddingTop: 0.26 }, children: [ROW] }

const mountWith = async ($: any, on: On, surface: string, beneath: unknown) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, new Map<string, unknown>([['welcomed', true]]), () => ({ status: 200, text: body() }))
  // With nothing given, the test's chain draws Claude Code's own placeholder beneath
  if (beneath !== undefined) on('ui.render', () => beneath as never)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
  return JSON.parse(JSON.stringify(await ui.drawn()))
}
const strip = (n: any): any => (n && typeof n === 'object' ? (({ part, ...rest }) => ({ ...rest, children: (rest.children ?? []).map(strip) }))(n) : n)

test('VS Code: the row goes on top, a divider joins it to a block that starts spaced, which is kept whole', async ($, on) => {
  const tree = await mountWith($, on, 'vscode', SPACED)
  expect(tree.type).toBe('Box')
  expect(tree.props).toEqual({ flexDirection: 'column', paddingTop: SPACE.above })
  const [row, divider, below] = tree.children
  expect(JSON.stringify(row)).toContain('"type":"Svg"')
  expect(divider).toEqual({
    type: 'Box',
    props: { flexDirection: 'column', height: 0, marginTop: SPACE.between },
    children: [{ type: 'Box', props: { height: 0.055, marginTop: 0.044, flexShrink: 0, backgroundColor: 'promptBorder' } }],
  })
  expect(strip(below)).toEqual(strip(SPACED))
})

test('VS Code: a block with no top space gets the space under the divider', async ($, on) => {
  const tree = await mountWith($, on, 'vscode', ROW)
  expect(tree.children[1].props.marginBottom).toBe(SPACE.unspaced)
  expect(tree.props.paddingBottom).toBeUndefined()
})

test('VS Code: with nothing beneath, or only the engine placeholder, the row stands alone and owns the bottom edge', async ($, on) => {
  const tree = await mountWith($, on, 'vscode', { type: 'Box', props: {}, children: [] })
  expect(tree.props).toEqual({ flexDirection: 'column', paddingTop: SPACE.above, paddingBottom: SPACE.end })
  expect(tree.children.length).toBe(1)
  expect(JSON.stringify(tree)).not.toContain('"engine"')
})

test('the engine placeholder is never nested', async ($, on) => {
  const tree = await mountWith($, on, 'desktop', undefined)
  expect(JSON.stringify(tree)).not.toContain('"type":"engine"')
  expect(JSON.stringify(tree)).toContain('"type":"Svg"')
})

test('the desktop and the terminal stack the row over the rows beneath, with no gap or divider', async ($, on) => {
  const tree = await mountWith($, on, 'desktop', ROW)
  expect(tree.props).toEqual({ flexDirection: 'column' })
  expect(tree.children.length).toBe(2)
  expect(strip(tree.children[1])).toEqual(strip(ROW))
  expect(JSON.stringify(tree)).not.toContain('promptBorder')
  // The desktop keeps upstream's SVG, now with the per-model window
  expect(String(JSON.stringify(tree))).toContain('Fable 7-day limit 20% used')
})

test('a survey keeps the slot to the hooks beneath', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, new Map<string, unknown>([['welcomed', true]]), () => ({ status: 200, text: body() }))
  on('ui.render', () => ROW as never)
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', component: 'AbovePrompt', props: { ...(BAND.props as object), hasSurvey: true } as never })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'fold' })).toBeDefined()
})
