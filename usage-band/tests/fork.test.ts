// The fork's own behaviour: the per-model weekly windows from the usage endpoint, the VS Code row
// in the box above the prompt, and how the row stacks with the rows of the hooks beneath it.
import { expect, mock, test } from 'claude-code/testing'

import {
  SCOPED_EVERY_MS,
  SCOPED_URL,
  SPACE,
  contrast,
  editorSvg,
  modelsAt,
  oklch,
  oklchHex,
  over,
  parseScoped,
} from '../hooks/register'
import type { Measure, TurnTokens } from '../types'

// The colors in the markup, as `oklch(from currentColor <L> <C> <H>)` where L and C step from their dark-theme
// value to their light-theme one: `calc(<dark> + clamp(0, (0.7 - l) * 10, 1) * (<light> - (<dark>)))`
const N = String.raw`-?[\d.]+`
// `again` is the dark value once more, inside the brackets, uncaptured
const STEPPED = (dark: string, again = dark) => String.raw`calc\(${dark} \+ clamp\(0, \(0\.7 - l\) \* 10, 1\) \* \((${N}) - \(${again}\)\)\)`
const FIGURE = new RegExp(String.raw`fill:oklch\(from currentColor ${STEPPED('l')} ${STEPPED(String.raw`0\.09`)} (${N})\)`, 'g')
const BAR_RE = new RegExp(String.raw`class="bar" style="fill:oklch\(from currentColor ${STEPPED(String.raw`0\.3 \+ 0\.5 \* l`)} ${STEPPED(`(${N})`, N)} (${N})\)`, 'g')
const figuresOf = (svg: string) => [...svg.matchAll(FIGURE)].map(m => ({ lightL: +m[1]!, lightC: +m[2]!, h: +m[3]! }))
const barsOf = (svg: string) => [...svg.matchAll(BAR_RE)].map(m => ({ lightL: +m[1]!, darkC: +m[2]!, lightC: +m[3]!, h: +m[4]! }))

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
  const { svg, widths } = editorSvg(MEASURE, TURN, NOW, FABLE)
  for (let i = 1; i < widths.length; i++) expect(widths[i]!).toBeLessThan(widths[i - 1]!)
  // A 280px panel leaves 262px inside the frame's border and padding
  expect(widths[widths.length - 1]!).toBeLessThanOrEqual(262)
  // 640px leaves 622: the full tier, with bars and reset times
  expect(widths[0]!).toBeLessThanOrEqual(622)
  expect(svg).toContain(`@media (max-width:${widths[0]! - 0.02}px){.v0{display:none}.v1{display:inline}}`)
  // The bars and the reset time are in the full tier
  expect(svg).toContain('4d6h')
})

test('the shine crosses once after a change, then the markup carries no animation', async () => {
  const fresh = editorSvg(MEASURE, TURN, NOW, FABLE, true).svg
  const still = editorSvg(MEASURE, TURN, NOW, FABLE, false).svg
  expect(fresh).toContain('linear 1"')
  expect(fresh).not.toContain('infinite')
  // Motion stops under prefers-reduced-motion (CHECKLIST #13)
  expect(fresh).toContain('@media (prefers-reduced-motion:reduce){.sh{animation:none!important}}')
  // The webview reads `animation:` as a moving picture and draws it frame by frame
  expect(still).not.toMatch(/<animate|animation(?:-[a-z-]{1,24})?\s*:(?!\s*none\b)/)
  // Each metric keeps its own hue on its figure and bar (7d, Fable, context; the cache has no bar)
  expect(new Set(figuresOf(still).map(f => f.h)).size).toBe(4)
  expect(new Set(barsOf(still).map(b => b.h)).size).toBe(3)
})

test('in VS Code the shine is due for 3 seconds after what the row shows changes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  world(on, new Map<string, unknown>([['welcomed', true]]), () => ({ status: 200, text: body() }))
  await $.session.start(START)
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', ...BAND })
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('animation:s')
  await clock.advance(3_000)
  await clock.settle()
  expect(String((await ui.find({ type: 'Svg' }))?.props.source)).not.toContain('animation:s')
  await ui.unmount()
})

test('a metric in trouble turns its figure and bar red', async () => {
  const hot: Measure = { ...MEASURE, rateLimits: [{ kind: 'seven_day', percentUsed: 85, resetsAt: RESET }] }
  const red = +oklch('#e5685f')[2].toFixed(3)
  const { svg } = editorSvg(hot, TURN, NOW, [])
  expect(figuresOf(svg).some(f => f.h === red)).toBe(true)
  expect(barsOf(svg).some(b => b.h === red)).toBe(true)
})

// The colors the webview works out, against VS Code's themes: the preview's light and dark, and
// Light (Visual Studio), the theme this machine uses (text #616161 on its side bar's #f3f3f3)
const THEMES = [
  { text: '#3b3b3b', bg: '#f8f8f8' },
  { text: '#cccccc', bg: '#1f1f1f' },
  { text: '#616161', bg: '#f3f3f3' },
]
// The step from the dark-theme value to the light-theme one, as the markup's clamp() works it out
const step = (l: number) => Math.max(0, Math.min(1, (0.7 - l) * 10))

test('figures keep 4.5:1 and bars 3:1, against the background and their track, in every theme', async () => {
  const hot: Measure = { ...MEASURE, rateLimits: [{ kind: 'seven_day', percentUsed: 85, resetsAt: RESET }] }
  const svg = editorSvg(MEASURE, TURN, NOW, FABLE).svg + editorSvg(hot, { ...TURN, cacheRead: 100 }, NOW, FABLE).svg
  const figures = figuresOf(svg)
  const bars = barsOf(svg)
  expect(figures.length).toBeGreaterThan(0)
  expect(bars.length).toBeGreaterThan(0)
  for (const { text, bg } of THEMES) {
    const l = oklch(text)[0]
    const s = step(l)
    for (const f of figures) {
      const hex = oklchHex(l + s * (f.lightL - l), 0.09 + s * (f.lightC - 0.09), f.h)
      expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5)
    }
    for (const b of bars) {
      const dark = 0.3 + 0.5 * l
      const fill = oklchHex(dark + s * (b.lightL - dark), b.darkC + s * (b.lightC - b.darkC), b.h)
      expect(contrast(fill, bg)).toBeGreaterThanOrEqual(3)
      // The track is the fill at 22% over the background
      expect(contrast(fill, over(fill, bg, 0.22))).toBeGreaterThanOrEqual(3)
    }
    // Muted text: currentColor mixed a quarter toward grey
    expect(contrast(over(text, '#888888', 0.75), bg)).toBeGreaterThanOrEqual(4.5)
  }
})

test('in a light theme each hue keeps its own color, not a brown or grey near the text', async () => {
  // The light-theme figures, by hue: far enough apart that 7d, Fable, the context and the cache read as four colors
  const svg = editorSvg(MEASURE, TURN, NOW, FABLE).svg
  const seen = new Map(figuresOf(svg).map(f => [f.h, f] as const))
  expect(seen.size).toBe(4)
  for (const f of seen.values()) expect(f.lightC).toBeGreaterThanOrEqual(0.11)
  // and lighter than the text (0.36 in the preview's light theme), as far as 4.5:1 allows
  for (const f of seen.values()) expect(f.lightL).toBeGreaterThan(0.5)
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
