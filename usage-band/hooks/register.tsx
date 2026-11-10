import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Measure, Scoped, ScopedReading, Style, TurnTokens } from '../types'

const measure = atom({ plugin: 'usage-band', key: 'measure' } as const, null)
const turn = atom({ plugin: 'usage-band', key: 'turn' } as const, null)
const now = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const phase = atom({ plugin: 'usage-band', key: 'phase' } as const, 0)
const style = atom({ plugin: 'usage-band', key: 'style' } as const, 'unicode')
const scoped = atom({ plugin: 'usage-band', key: 'scoped' } as const, null)
const sweep = atom({ plugin: 'usage-band', key: 'sweep' } as const, false)

// One hue per metric; RED takes over only when a metric is in trouble
const HUE = { five: '#5cc4d6', seven: '#e8a25f', ctx: '#9aa5f5', cache: '#72cf9f', model: '#d78bd0' }
const RED = '#e5685f'
const TRACK = '#4a4f5c'
const FRAME_MS = 200
const PREVIEW = 'usage-band-preview'

export const GLYPHS: Record<Style, { ctx: string; hit: string; fill: string; track: string }> = {
  nerd: { ctx: '\u{F0328} ', hit: '\u{F04FE} ', fill: '■', track: '■' },
  unicode: { ctx: '≡ ', hit: '● ', fill: '■', track: '■' },
  ascii: { ctx: 'ctx ', hit: 'hit ', fill: '#', track: '-' },
}

// Terminals known to ship Nerd Font symbols without the user installing a font
const NERD_BUILTIN = new Set(['ghostty'])

export const detectStyle = (setting: string, termProgram: string | undefined): Style => {
  if (setting === 'nerd' || setting === 'unicode' || setting === 'ascii') return setting
  return NERD_BUILTIN.has((termProgram ?? '').toLowerCase()) ? 'nerd' : 'unicode'
}

export const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

export const fmtLeft = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export const hitRate = (t: TurnTokens): number | null => {
  const total = t.input + t.cacheRead + t.cacheWrite
  return total === 0 ? null : Math.round((t.cacheRead / total) * 100)
}

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const ch = (v: number) => Math.round(v + (target - v) * Math.abs(t)).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

// Nearest xterm-256 color, to preview how a 256-color terminal shows the band
export const to256 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const levels = [0, 95, 135, 175, 215, 255]
  const nearest = (v: number) => levels.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
  const cube = rgb.map(nearest)
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3
  const g = Math.min(238, Math.max(8, 8 + Math.round((avg - 8) / 10) * 10))
  const dist = (c: readonly number[]) => c.reduce((s, v, i) => s + (v - rgb[i]!) ** 2, 0)
  const pick = dist(cube) <= dist([g, g, g]) ? cube : [g, g, g]
  return `#${pick.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// A window as a bar draws it: the engine's limits and the per-model windows alike
type Window = Pick<Limit, 'percentUsed' | 'resetsAt'>

export type Span = { text: string; color?: string; dim?: boolean }
export type Look = { style: Style; colors: 'true' | '256' }

const SEP: Span = { text: '  ' }

export const width = (spans: Span[]) => spans.reduce((n, s) => n + [...s.text].length, 0)

// A bar whose filled part runs from a deep shade of its color to a bright one,
// with a soft highlight sweeping left to right on top
export const bar = (pct: number, cells: number, color: string, frame: number, s: Style = 'unicode'): Span[] => {
  const g = GLYPHS[s]
  const filled = Math.max(pct > 0 ? 1 : 0, Math.min(cells, Math.round((pct / 100) * cells)))
  // Same period for every bar, so all highlights travel in step
  const pos = frame % (cells + 5)
  const spans: Span[] = []
  for (let i = 0; i < filled; i++) {
    const shade = filled === 1 ? 0 : -0.15 + (0.35 * i) / (filled - 1)
    const glow = i === pos ? 0.55 : i === pos - 1 || i === pos + 1 ? 0.25 : 0
    spans.push({ text: g.fill, color: lighten(lighten(color, shade), glow) })
  }
  if (cells > filled) spans.push({ text: g.track.repeat(cells - filled), color: TRACK })
  return spans
}

// detail 2: bars + countdowns; 1: no bars; 0: bare numbers
export const layout = (
  m: Measure | null,
  t: TurnTokens | null,
  at: number,
  detail: 0 | 1 | 2,
  frame = 0,
  look: Look = { style: 'unicode', colors: 'true' },
  models: Scoped[] = [],
  cells = 8,
): Span[] => {
  const g = GLYPHS[look.style]
  const groups: Span[][] = []

  const limit = (label: string, l: Window | undefined, hue: string) => {
    if (!l) return
    const pct = Math.round(l.percentUsed)
    const color = pct >= 80 ? RED : hue
    const out: Span[] = [{ text: `${label} `, color }]
    if (detail === 2) out.push(...bar(pct, cells, color, frame, look.style), { text: ' ' })
    out.push({ text: `${pct}%`, color })
    if (detail >= 1 && l.resetsAt) out.push({ text: ` · ${fmtLeft(Date.parse(l.resetsAt) - at)}`, dim: true })
    groups.push(out)
  }
  limit('5h', m?.rateLimits.find(l => l.kind === 'five_hour'), HUE.five)
  limit('7d', m?.rateLimits.find(l => l.kind === 'seven_day'), HUE.seven)
  for (const s of models) limit(s.label, s, HUE.model)

  if (m) {
    const pct = m.context.percent ?? 0
    const color = pct >= 80 ? RED : HUE.ctx
    groups.push([
      { text: g.ctx, color },
      { text: fmtTokens(m.context.tokens ?? 0), color },
      { text: `/${fmtTokens(m.context.window)}`, dim: true },
    ])
  }

  const hit = t ? hitRate(t) : null
  if (hit !== null) {
    const color = hit < 50 ? RED : HUE.cache
    groups.push([
      { text: g.hit, color },
      { text: `${hit}%`, color },
    ])
  }

  const spans = groups.flatMap((grp, i) => (i === 0 ? grp : [SEP, ...grp]))
  return look.colors === '256' ? spans.map(s => (s.color ? { ...s, color: to256(s.color) } : s)) : spans
}

// The terminal line: the richest detail that fits `cols` cells. Claude Code's own `[-]` (collapse the band) sits right
// of `bodyColumns`, over the slot's last 5 cells (measured in a live terminal), so the line never reaches it. With bars, the line takes all of them: every bar
// lengthens by the same whole number of cells, so bars stay comparable, and the cells left over (fewer than the bars)
// widen the last gap.
export const fit = (m: Measure | null, t: TurnTokens | null, at: number, cols: number, frame: number, look: Look, models: Scoped[]): Span[] => {
  const base = layout(m, t, at, 2, frame, look, models)
  if (width(base) <= cols) {
    // One bar per limit the line shows: the 5-hour and 7-day windows, and each per-model one
    const bars = ['five_hour', 'seven_day'].filter(k => m?.rateLimits.some(l => l.kind === k)).length + models.length
    if (bars === 0) return base
    const extra = cols - width(base)
    const grown = layout(m, t, at, 2, frame, look, models, 8 + Math.floor(extra / bars))
    const left = cols - width(grown)
    const last = grown.lastIndexOf(SEP)
    if (left > 0 && last >= 0) grown[last] = { text: SEP.text + ' '.repeat(left) }
    return grown
  }
  return ([1, 0] as const).map(d => layout(m, t, at, d, frame, look, models)).find(s => width(s) <= cols) ??
    layout(m, t, at, 0, frame, look, models)
}


// ---- Desktop: the band is one SVG drawn as a plain image. The SMIL shine runs in an image too,
// and an image redraws in place, where an interactive (framed) SVG reloads its frame and blinks
// the whole band on every redraw.

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// CAP: the band the figures' cap height occupies (Inter 13px on baseline 19.5);
// icons, dots and the inner rule are sized to it so the row reads one height
const CAP = { top: 9.75, h: 10 }
const D = { h: 30, gap: 30, inner: 7, sm: 13, md: 13, base: 13, barW: 76, barH: 6 }
// Advance widths in em for Inter with tabular figures (SF Pro, the fallback, runs within a few %).
// Each text also sets textLength to this width, so a font that runs wider or narrower only
// changes letter spacing and never pushes into the next element.
const ADVANCE: Record<string, number> = { h: 0.58, d: 0.6, m: 0.9, K: 0.64, M: 0.84, '%': 0.84, '/': 0.36, '.': 0.27, ' ': 0.26 }
// Extra space between letters, in px; textLength spreads it evenly across each string
const TRACKING = 0.2
const textW = (v: string, size: number) =>
  [...v].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.62 : (ADVANCE[c] ?? 0.6)), 0) * size +
  TRACKING * Math.max(0, [...v].length - 1)

// Text tinted toward the hue: deeper on light backgrounds, lighter on dark ones
const pinW = (v: string, size: number) => `textLength="${textW(v, size).toFixed(1)}" lengthAdjust="spacing"`
const ink = (hue: string, x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${esc(v)}</text>`
const mute = (x: number, y: number, v: string, size: number) =>
  `<text x="${x}" y="${y}" font-size="${size}" ${pinW(v, size)} class="mute">${esc(v)}</text>`

// stat: type, icons and rules; motion: bars and dots with their shine
type Layers = { stat: string; motion: string }
type Group = { width: number; draw: (x: number) => Layers }

// 5h 60% ▬▬▬▬── 1h49m: the figure first, so the state reads before the bar
// 5h ▬▬▬▬▬▬──── 69% │ 1h31m: label, bar, figure, then when it resets
const limitGroup = (id: string, label: string, l: Window, hue: string, at: number): Group => {
  const pct = Math.round(l.percentUsed)
  const color = pct >= 80 ? RED : hue
  const pctText = `${pct}%`
  const left = l.resetsAt ? fmtLeft(Date.parse(l.resetsAt) - at) : ''
  const labelW = textW(label, D.base) + D.inner
  const pctW = textW(pctText, D.base)
  const width = labelW + D.barW + D.inner + pctW + (left ? D.inner * 2 + 1 + textW(left, D.sm) : 0)
  const fillW = Math.max(pct > 0 ? D.barH : 0, Math.min(D.barW, (D.barW * pct) / 100))
  return {
    width,
    draw: x => {
      const bx = x + labelW
      const y = (D.h - D.barH) / 2
      const r = D.barH / 2
      const px = bx + D.barW + D.inner
      const motion = [
        `<defs><clipPath id="c-${id}"><rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}"/></clipPath></defs>`,
        `<rect x="${bx}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${r}" class="track" style="--h:${color}"/>`,
        `<rect x="${bx}" y="${y}" width="${fillW}" height="${D.barH}" rx="${r}" fill="${lighten(color, -0.12)}"/>`,
        // The shine crosses the whole bar on one shared clock and shows only over the fill,
        // so both bars' shines sit at the same spot at every moment
        `<g clip-path="url(#c-${id})"><rect y="${y}" width="18" height="${D.barH}" fill="url(#shine)">` +
          `<animate attributeName="x" values="${bx - 18};${bx + D.barW};${bx + D.barW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      ]
      const stat = [ink(color, x, 19.5, label, D.base), ink(color, px, 19.5, pctText, D.base)]
      if (left) {
        const rx = px + pctW + D.inner
        stat.push(`<rect x="${rx}" y="${CAP.top}" width="1" height="${CAP.h}" class="rule"/>`, mute(rx + 1 + D.inner, 19.5, left, D.sm))
      }
      return { stat: stat.join(''), motion: motion.join('') }
    },
  }
}

// Three stacked sheets: the context window
const layersIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2" stroke-linejoin="round">` +
  `<path d="M5 0.6 L9.4 2.8 L5 5 L0.6 2.8 Z" fill="${color}" fill-opacity="0.25"/>` +
  `<path d="M0.6 5.2 L5 7.4 L9.4 5.2"/><path d="M0.6 7.2 L5 9.4 L9.4 7.2"/></g>`

// A target: how much of the prompt the cache hit
const targetIcon = (color: string) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="${color}"/></g>`

// Icons are drawn in a CAP.h square, outer stroke edge included
const ICON = CAP.h

// icon · NUMBER suffix
const typeGroup = (icon: (c: string) => string, hue: string, num: string, suffix: string): Group => {
  const lw = ICON + 6
  const nw = textW(num, D.md)
  const sw = suffix ? textW(suffix, D.sm) + 1 : 0
  return {
    width: lw + nw + sw,
    draw: x => {
      const nx = x + lw
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${icon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          (suffix ? mute(nx + nw + 1, 19.5, suffix, D.sm) : ''),
        motion: '',
      }
    },
  }
}

// Context as a 2×10 dot matrix: one dot per 1/20 of the window (50K of 1M), filling the top
// row left to right before the bottom one, with the same shine over the lit dots
// Rows sit so the dots' outer edges meet the CAP band: CAP.top + r and CAP.top + CAP.h - r
const DOTS = { cols: 10, pitch: 5, r: 1.6, rows: [11.35, 18.15] }
const ctxGroup = (hue: string, tokens: number, window: number, pct: number): Group => {
  const lit = Math.min(DOTS.cols * 2, Math.round((pct / 100) * DOTS.cols * 2))
  const num = fmtTokens(tokens)
  const suffix = `/${fmtTokens(window)}`
  const lw = ICON + 6
  const matrixW = DOTS.cols * DOTS.pitch
  return {
    width: lw + matrixW + D.inner + textW(num, D.md) + 1 + textW(suffix, D.sm),
    draw: x => {
      const mx = x + lw
      const dot = (i: number) =>
        `<circle cx="${mx + DOTS.pitch / 2 + (i % DOTS.cols) * DOTS.pitch}" cy="${DOTS.rows[Math.floor(i / DOTS.cols)]}" r="${DOTS.r}"/>`
      const on = Array.from({ length: lit }, (_, i) => dot(i)).join('')
      const off = Array.from({ length: DOTS.cols * 2 - lit }, (_, i) => dot(lit + i)).join('')
      const nx = mx + matrixW + D.inner
      return {
        stat:
          `<g transform="translate(${x} ${CAP.top})">${layersIcon(lighten(hue, -0.15))}</g>` +
          ink(hue, nx, 19.5, num, D.md) +
          mute(nx + textW(num, D.md) + 1, 19.5, suffix, D.sm),
        motion:
          `<defs><clipPath id="c-ctx">${on}</clipPath></defs>` +
          `<g class="track" style="--h:${hue}">${off}</g>` +
          `<g fill="${lighten(hue, -0.12)}">${on}</g>` +
          `<g clip-path="url(#c-ctx)"><rect y="8" width="18" height="14" fill="url(#shine)">` +
          `<animate attributeName="x" values="${mx - 18};${mx + matrixW};${mx + matrixW}" keyTimes="0;0.62;1" dur="2.6s" repeatCount="indefinite"/></rect></g>`,
      }
    },
  }
}

// An image takes its color scheme from the app; a frame (should the band ever be framed) whose color scheme differs from the app's
// gets an opaque canvas behind it (white in a dark app). Declaring both schemes lets it follow the
// app and stay transparent.
const SVG_HEAD =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.track{fill:var(--h);fill-opacity:.22}` +
  `.ink{fill:var(--l)}.mute{fill:#8b8f97;font-weight:400}.rule{fill:#000;fill-opacity:.1}.sep{fill:#000;fill-opacity:.2}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.rule{fill:#fff;fill-opacity:.13}.sep{fill:#fff;fill-opacity:.22}}` +
  `</style>` +
  `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`

const wrap = (width: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${D.h}" viewBox="0 0 ${width} ${D.h}" style="color-scheme:light dark;background:transparent">${SVG_HEAD}${body}</svg>`

export type Part = Layers & { width: number; alt: string }

export const desktopParts = (m: Measure | null, t: TurnTokens | null, at: number, models: Scoped[] = []): Part[] => {
  const groups: { g: Group; alt: string }[] = []
  const five = m?.rateLimits.find(l => l.kind === 'five_hour')
  const seven = m?.rateLimits.find(l => l.kind === 'seven_day')
  if (five) groups.push({ g: limitGroup('5h', '5h', five, HUE.five, at), alt: `5-hour limit ${Math.round(five.percentUsed)}% used` })
  if (seven) groups.push({ g: limitGroup('7d', '7d', seven, HUE.seven, at), alt: `7-day limit ${Math.round(seven.percentUsed)}% used` })
  models.forEach((s, i) =>
    groups.push({ g: limitGroup(`m${i}`, s.label, s, HUE.model, at), alt: `${s.label} 7-day limit ${Math.round(s.percentUsed)}% used` }),
  )
  if (m) {
    const pct = m.context.percent ?? 0
    groups.push({
      g: ctxGroup(pct >= 80 ? RED : HUE.ctx, m.context.tokens ?? 0, m.context.window, pct),
      alt: `context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`,
    })
  }
  const hit = t ? hitRate(t) : null
  if (hit !== null) groups.push({ g: typeGroup(targetIcon, hit < 50 ? RED : HUE.cache, `${hit}%`, ''), alt: `cache hit ${hit}%` })
  return groups.map(({ g, alt }) => {
    const width = Math.ceil(g.width + 2)
    return { ...g.draw(1), width, alt }
  })
}

// One SVG for the whole band, so every shine runs on the same clock. Groups sit D.gap apart
// with a hairline centred in each gap; the one inside a limit group is shorter and fainter.
export const desktopSvg = (m: Measure | null, t: TurnTokens | null, at: number, models: Scoped[] = []) => {
  let x = 0
  const body: string[] = []
  desktopParts(m, t, at, models).forEach((p, i) => {
    if (i > 0) body.push(`<rect x="${Math.round(x - D.gap / 2)}" y="7" width="1" height="16" class="sep"/>`)
    body.push(`<g transform="translate(${x} 0)">${p.stat}${p.motion}</g>`)
    x += p.width + D.gap
  })
  const width = Math.max(1, Math.ceil(x - D.gap))
  return { svg: wrap(width, body.join('')), width, height: D.h }
}

export const describe = (m: Measure | null, t: TurnTokens | null, models: Scoped[] = []) => {
  const parts: string[] = []
  for (const l of m?.rateLimits ?? []) {
    if (l.kind === 'five_hour') parts.push(`5-hour limit ${Math.round(l.percentUsed)}% used`)
    if (l.kind === 'seven_day') parts.push(`7-day limit ${Math.round(l.percentUsed)}% used`)
  }
  for (const s of models) parts.push(`${s.label} 7-day limit ${Math.round(s.percentUsed)}% used`)
  if (m) parts.push(`context ${fmtTokens(m.context.tokens ?? 0)} of ${fmtTokens(m.context.window)}`)
  const hit = t ? hitRate(t) : null
  if (hit !== null) parts.push(`cache hit ${hit}%`)
  return parts.join(', ')
}

// ---- Per-model weekly windows (Fable's, for one). Neither `$.session.usage()` nor
// `session.measure` carries them; the usage endpoint that Claude Code's own /usage screen reads
// does, in its `limits` list as `weekly_scoped` rows scoped to a model. It is asked at most once
// per SCOPED_EVERY_MS across every open session: the sessions share the reading and the time of
// the last attempt through `$.store`.

export const SCOPED_URL = 'https://api.anthropic.com/api/oauth/usage'
export const SCOPED_EVERY_MS = 5 * 60_000
// A reading this old says nothing current (the endpoint has failed for half an hour), so it is
// no longer drawn
export const SCOPED_STALE_MS = 30 * 60_000
export const SCOPED_KEY = 'scoped'
export const SCOPED_TRIED_KEY = 'scoped-tried'

const isoOf = (v: unknown): string | undefined => {
  // The endpoint answers ISO 8601; a rate-limit header's epoch seconds are read too
  const ms = typeof v === 'number' ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

// The per-model weekly windows in an answer of the usage endpoint: its `limits` rows of kind
// `weekly_scoped` (`percent`, `resets_at`, `scope.model.display_name`), or, in the shape Claude
// Code's SDK projects them to, `model_scoped` (`display_name`, `utilization`, `resets_at`).
// An empty list for an account with none; null for an answer in neither shape.
export const parseScoped = (body: unknown): Scoped[] | null => {
  if (typeof body !== 'object' || body === null) return null
  const { limits, model_scoped } = body as { limits?: unknown; model_scoped?: unknown }
  const out: Scoped[] = []
  const add = (label: unknown, pct: unknown, reset: unknown) => {
    if (typeof label !== 'string' || label.trim() === '' || typeof pct !== 'number' || !Number.isFinite(pct)) return
    const resetsAt = isoOf(reset)
    out.push({ label: label.trim(), percentUsed: pct, ...(resetsAt && { resetsAt }) })
  }
  if (Array.isArray(limits)) {
    for (const l of limits as { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } | null } | null }[]) {
      if (l?.kind === 'weekly_scoped') add(l.scope?.model?.display_name, l.percent, l.resets_at)
    }
    return out
  }
  if (Array.isArray(model_scoped)) {
    for (const l of model_scoped as { display_name?: unknown; utilization?: unknown; resets_at?: unknown }[]) add(l?.display_name, l?.utilization, l?.resets_at)
    return out
  }
  return null
}

const asReading = (v: unknown): ScopedReading | null => {
  const r = v as ScopedReading | null
  return r !== null && typeof r === 'object' && typeof r.at === 'number' && Array.isArray(r.limits) ? r : null
}

// The windows a reading draws at `at`: none from a stale reading, and none whose window has reset
// since it was read (the next reading says where the new window stands)
export const modelsAt = (r: ScopedReading | null, at: number): Scoped[] => {
  if (!r || at - r.at > SCOPED_STALE_MS) return []
  return r.limits.filter(l => !l.resetsAt || Date.parse(l.resetsAt) > at)
}

// Asks the endpoint when the shared attempt is due, and takes what it answers; otherwise takes the
// reading another session shared. A session with no first-party login, a refused request or an
// answer in another shape keeps the reading it has. The attempt's time is written before the
// request, so the sessions that tick meanwhile wait out the same five minutes.
export const pollScoped = async ($: EngineInterface): Promise<void> => {
  const at = await $.clock.now()
  const tried = await $.store.get(SCOPED_TRIED_KEY)
  const due = !(typeof tried === 'number' && tried <= at && at - tried < SCOPED_EVERY_MS)
  if (due) {
    try {
      const auth = await $.session.authorize()
      if (auth) {
        await $.store.set(SCOPED_TRIED_KEY, at)
        const res = await $.http.fetch(SCOPED_URL, { auth: auth.handle })
        const limits = res.ok ? parseScoped(JSON.parse(res.text)) : null
        if (limits) {
          const reading = { at, limits }
          await $.store.set(SCOPED_KEY, reading)
          await setScoped($, reading)
          return
        }
      }
    } catch {
      // The next attempt is five minutes away
    }
  }
  const shared = asReading(await $.store.get(SCOPED_KEY))
  if (shared) await setScoped($, shared)
}

// ---- VS Code: the desktop's look, in one SVG that fills the row of the box above the prompt
// (layout/ABOVE-PROMPT.md). The webview draws an Svg as an image in a sandboxed frame and hands the
// markup the theme's text color as `color`. Inside that frame `prefers-color-scheme` follows the
// operating system, not the editor's theme (VS Code's `window.systemColorTheme` defaults to the
// system), so the markup asks no media query for its colors: every color is worked out from
// currentColor, which is the theme's text color, light or dark. It holds every detail tier laid
// out in full, and a width media query, which inside the image reads the width the webview gives
// it, shows the richest tier that fits on one line: bars and reset times, then bars, then short
// bars, then the figures alone. Each metric keeps upstream's hue on its label, figure, bar and
// icon; a metric in trouble (a limit or the context past 80%, a hit rate under 50%) turns red.

// The row's markup height and its ink: the cap band (the figures' cap and ascender height, which
// the icons, bars and dots are sized to) runs EC.top to EC.top + EC.h, in the middle of the markup
export const EH = 13
const EC = { top: 1.5, h: 10 }
const EBASE = EC.top + 9.75
const EBAR = { h: 6, y: EC.top + EC.h / 2 - 3 }
const EDOT = { cols: 10, pitch: 5, r: 1.6, rows: [EC.top + 1.6, EC.top + EC.h - 1.6] }
const EICON = 10

// One tier per detail level, richest first: bar length (0 for none), the context's dot matrix,
// reset times, the context's icon (`176K/1M` reads as the context without it), the space between
// groups (a hairline in its middle) and inside them. The last fits the four groups in a 280px panel.
type Tier = { bar: number; dots: boolean; resets: boolean; ctxIcon: boolean; gap: number; inner: number }
export const TIERS: readonly Tier[] = [
  { bar: 60, dots: true, resets: true, ctxIcon: true, gap: 22, inner: 6 },
  { bar: 60, dots: true, resets: false, ctxIcon: true, gap: 22, inner: 6 },
  { bar: 32, dots: false, resets: false, ctxIcon: true, gap: 18, inner: 6 },
  { bar: 0, dots: false, resets: false, ctxIcon: true, gap: 12, inner: 5 },
  { bar: 0, dots: false, resets: false, ctxIcon: false, gap: 10, inner: 4 },
]

// Advance widths in em of the system font at 13px, weight 500, tabular figures (SF Pro, measured);
// each text also sets textLength to this width, so another font changes letter spacing only
const EADV: Record<string, number> = {
  h: 0.6, d: 0.62, m: 0.89, K: 0.67, M: 0.88, '%': 0.96, '/': 0.31, '.': 0.31, ' ': 0.27,
  F: 0.58, a: 0.56, b: 0.62, l: 0.26, e: 0.58, s: 0.53, O: 0.77, p: 0.62, u: 0.59, S: 0.64, n: 0.59, t: 0.37, o: 0.6, r: 0.4, i: 0.26, H: 0.72, k: 0.55, c: 0.55,
}
const eTextW = (v: string, size = 13) =>
  [...v].reduce((w, c) => w + (c >= '0' && c <= '9' ? 0.64 : (EADV[c] ?? 0.62)), 0) * size + 0.2 * Math.max(0, [...v].length - 1)

// sRGB hex to OKLCH lightness, chroma and hue (Björn Ottosson's OKLab)
export const oklch = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}

// OKLCH to sRGB hex, and whether it is inside sRGB; WCAG contrast of two hex colors
const oklchRgb = (L: number, C: number, H: number): number[] => {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614601 * s]
}
const inGamut = (L: number, C: number, H: number) => oklchRgb(L, C, H).every(v => v >= -1e-4 && v <= 1 + 1e-4)
export const oklchHex = (L: number, C: number, H: number): string =>
  `#${oklchRgb(L, C, H)
    .map(v => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))).toString(16).padStart(2, '0'))
    .join('')}`
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255)
}
export const contrast = (x: string, y: string) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (hi! + 0.05) / (lo! + 0.05)
}
export const over = (fg: string, bg: string, alpha: number) =>
  `#${[0, 1, 2].map(i => Math.round(alpha * parseInt(fg.slice(1 + 2 * i, 3 + 2 * i), 16) + (1 - alpha) * parseInt(bg.slice(1 + 2 * i, 3 + 2 * i), 16)).toString(16).padStart(2, '0')).join('')}`

// The colors, each worked out from currentColor (the theme's text) in CSS, so one markup reads in
// either theme; each carries a plain fallback for a renderer without relative colors. A step on
// the text's OKLCH lightness tells the themes apart: 1 under 0.6 (a light theme's dark text), 0
// over 0.7 (a dark theme's light text).
// - Dark: a figure keeps the text's lightness and takes its hue at chroma 0.09; a bar or lit dot
//   is the hue at lightness 0.3 + 0.5 × the text's, chroma up to 0.14. Both read close to the hue.
// - Light: at the text's lightness a hue is a dull brown or grey, so each hue gets its own color:
//   the lightest, at chroma up to LIGHT_C inside sRGB, that keeps 4.6:1 (a figure) or 3.05:1
//   against both the background and its 22% track (a bar) on LIGHT_BGS.
// - The track is the bar's color at 22% (upstream's); the hairlines are currentColor at upstream's
//   opacities; muted text is currentColor mixed a quarter toward grey (4.8:1 and up).
export const DARK = { figureC: 0.09, barL0: 0.3, barK: 0.5, barC: 0.14 } as const
// VS Code's Light Modern (the preview's light theme) and Light (Visual Studio)'s side bar
export const LIGHT_BGS = ['#f8f8f8', '#f3f3f3'] as const
const LIGHT_C = 0.15
export const LIGHT_NEED = { figure: 4.6, bar: 3.05 } as const
const STEP = 'clamp(0, (0.7 - l) * 10, 1)'
const r3 = (v: number) => +v.toFixed(3)

// The lightest color of hue H at chroma up to LIGHT_C, in gamut, that `ok` accepts
const lightest = (H: number, ok: (hex: string) => boolean): { L: number; C: number } => {
  for (let i = 700; i > 300; i--) {
    const L = i / 1000
    let C = 0
    while (C + 0.001 <= LIGHT_C && inGamut(L, C + 0.001, H)) C += 0.001
    if (ok(oklchHex(L, C, H))) return { L: r3(L), C: r3(C) }
  }
  return { L: 0.3, C: 0 }
}
const lightCache = new Map<string, { figure: { L: number; C: number }; bar: { L: number; C: number } }>()
export const lightTint = (hue: string) => {
  let t = lightCache.get(hue)
  if (!t) {
    const H = oklch(hue)[2]
    t = {
      figure: lightest(H, x => LIGHT_BGS.every(bg => contrast(x, bg) >= LIGHT_NEED.figure)),
      bar: lightest(H, x => LIGHT_BGS.every(bg => contrast(x, bg) >= LIGHT_NEED.bar && contrast(x, over(x, bg, 0.22)) >= LIGHT_NEED.bar)),
    }
    lightCache.set(hue, t)
  }
  return t
}
// A channel that is `dark` in a dark theme and `light` in a light one
const stepped = (dark: string, light: number) => `calc(${dark} + ${STEP} * (${light} - (${dark})))`
const figureFill = (hue: string) => {
  const { figure } = lightTint(hue)
  return `fill:oklch(from currentColor ${stepped('l', figure.L)} ${stepped(String(DARK.figureC), figure.C)} ${r3(oklch(hue)[2])})`
}
const barColor = (hue: string) => {
  const [, c, h] = oklch(hue)
  const { bar } = lightTint(hue)
  return `oklch(from currentColor ${stepped(`${DARK.barL0} + ${DARK.barK} * l`, bar.L)} ${stepped(String(r3(Math.min(c, DARK.barC))), bar.C)} ${r3(h)})`
}

type EMetric =
  | { kind: 'limit'; id: string; label: string; pct: number; left: string; hue: string; alt: string }
  | { kind: 'ctx'; tokens: string; window: string; pct: number; hue: string; alt: string }
  | { kind: 'cache'; pct: number; hue: string; alt: string }

export const editorMetrics = (m: Measure | null, t: TurnTokens | null, at: number, models: Scoped[] = []): EMetric[] => {
  const out: EMetric[] = []
  const limit = (id: string, label: string, l: Window | undefined, hue: string, alt: string) => {
    if (!l) return
    const pct = Math.round(l.percentUsed)
    out.push({ kind: 'limit', id, label, pct, left: l.resetsAt ? fmtLeft(Date.parse(l.resetsAt) - at) : '', hue: pct >= 80 ? RED : hue, alt })
  }
  const five = m?.rateLimits.find(l => l.kind === 'five_hour')
  const seven = m?.rateLimits.find(l => l.kind === 'seven_day')
  limit('5h', '5h', five, HUE.five, `5-hour limit ${Math.round(five?.percentUsed ?? 0)}% used`)
  limit('7d', '7d', seven, HUE.seven, `7-day limit ${Math.round(seven?.percentUsed ?? 0)}% used`)
  models.forEach((s, i) => limit(`m${i}`, s.label, s, HUE.model, `${s.label} 7-day limit ${Math.round(s.percentUsed)}% used`))
  if (m) {
    const pct = m.context.percent ?? 0
    out.push({ kind: 'ctx', tokens: fmtTokens(m.context.tokens ?? 0), window: `/${fmtTokens(m.context.window)}`, pct, hue: pct >= 80 ? RED : HUE.ctx, alt: '' })
  }
  const hit = t ? hitRate(t) : null
  if (hit !== null) out.push({ kind: 'cache', pct: hit, hue: hit < 50 ? RED : HUE.cache, alt: '' })
  return out
}

const SHINE_W = 18
const MUTE = 'color-mix(in srgb,currentColor 75%,#888)'

// The row takes the width its tier leaves over, so it ends at the right edge: its bars lengthen, all
// by the same amount; a tier with no bars widens its gaps instead, each by the same amount, the
// hairline staying in its middle.
// The last figure's advance ends RIGHT_INSET inside the right edge, which puts its ink (the `%`'s
// side bearing is 0.5px) where the band's crab ends. The first starts at LEFT_X, which puts its ink
// (the `7`'s side bearing is about 0.5px) where the band's bar and the fold row's first button start.
export const RIGHT_INSET = 1.5
export const LEFT_X = -0.5

// One tier's groups, laid out from x = LEFT_X: its width, and its markup. `E` is the width the tier
// leaves over, as a CSS length; each part sits `k` shares of it further right.
const editorTier = (ms: EMetric[], tier: Tier, ti: number, shines: boolean) => {
  const bars = tier.bar > 0 ? ms.filter(mt => mt.kind === 'limit').length : 0
  const gaps = Math.max(0, ms.length - 1)
  const barShare = bars > 0 ? 1 / bars : 0
  const gapShare = bars === 0 && gaps > 0 ? 1 / gaps : 0
  const lay = (E: string | null) => {
    const fig = (hue: string, x: number, v: string) =>
      `<text x="${r3(x)}" y="${EBASE}" textLength="${r3(eTextW(v))}" lengthAdjust="spacing" class="n" style="${figureFill(hue)}">${esc(v)}</text>`
    const lab = fig
    const mute = (x: number, v: string) =>
      `<text x="${r3(x)}" y="${EBASE}" textLength="${r3(eTextW(v))}" lengthAdjust="spacing" class="m">${esc(v)}</text>`
    const paintBar = (hue: string) => `fill:${barColor(hue)}`
    const iconAt = (x: number, hue: string, body: string) =>
      `<g class="ic" transform="translate(${r3(x)} ${EC.top})" style="color:${barColor(hue)}">${body}</g>`
    // A bar's length, and the shine's run across it, as CSS lengths
    const grown = E && barShare ? `calc(${tier.bar}px + ${r3(barShare)} * ${E})` : `${tier.bar}px`
    const run = E && barShare ? `calc(${tier.bar + SHINE_W}px + ${r3(barShare)} * ${E})` : `${tier.bar + SHINE_W}px`
    // The shine crosses once; the markup drawn after it carries no animation
    const anim = (name: string) => ` style="animation:${name} 2.6s linear 1"`
    const used = new Map<string, string>()
    let x = LEFT_X
    let k = 0
    const parts: { k: number; s: string }[] = []
    const put = (...s: string[]) => s.forEach(v => parts.push({ k, s: v }))
    ms.forEach((mt, gi) => {
      if (gi > 0) {
        const mid = Math.round(x + tier.gap / 2) - 0.5
        k += gapShare / 2
        put(`<rect x="${r3(mid)}" y="${EC.top}" width="1" height="${EC.h}" class="sep"/>`)
        k += gapShare / 2
        x += tier.gap
      }
      const id = `t${ti}g${gi}`
      if (mt.kind === 'limit') {
        put(lab(mt.hue, x, mt.label))
        x += eTextW(mt.label) + tier.inner
        if (tier.bar > 0) {
          const fw = Math.max(mt.pct > 0 ? EBAR.h : 0, Math.min(tier.bar, (tier.bar * mt.pct) / 100))
          const fill = E && barShare ? (mt.pct > 0 ? `max(${EBAR.h}px, calc(${grown} * ${r3(Math.min(100, mt.pct) / 100)}))` : '0px') : `${r3(fw)}px`
          const bar = `x="${r3(x)}" y="${EBAR.y}" height="${EBAR.h}" rx="${EBAR.h / 2}"`
          // A grown length goes in the style (a CSS length, after the paint), the plain one in the attribute
          const sized = E && barShare
          const rect = (cls: string, w: string, px: number) =>
            `<rect ${bar} width="${r3(px)}"${cls ? ` class="${cls}"` : ''}` +
            (cls || sized ? ` style="${[cls ? paintBar(mt.hue) : '', sized ? `width:${w}` : ''].filter(Boolean).join(';')}"` : '') + '/>'
          put(rect('trk', grown, tier.bar), rect('bar', fill, fw))
          if (shines && fw > 0) {
            const name = barShare ? `s${ti}b` : `s${tier.bar + SHINE_W}`
            used.set(name, run)
            put(
              `<clipPath id="c${id}">${rect('', fill, fw)}</clipPath>`,
              `<g clip-path="url(#c${id})"><rect class="sh" x="${r3(x - SHINE_W)}" y="${EBAR.y}" width="${SHINE_W}" height="${EBAR.h}" fill="url(#shine)"${anim(name)}/></g>`,
            )
          }
          x += tier.bar + tier.inner
          k += barShare
        }
        const pct = `${mt.pct}%`
        put(fig(mt.hue, x, pct))
        x += eTextW(pct)
        if (tier.resets && mt.left) {
          x += tier.inner
          put(`<rect x="${r3(x)}" y="${EC.top}" width="1" height="${EC.h}" class="rule"/>`)
          x += 1 + tier.inner
          put(mute(x, mt.left))
          x += eTextW(mt.left)
        }
      } else if (mt.kind === 'ctx') {
        if (tier.ctxIcon) {
          put(iconAt(x, mt.hue, LAYERS_ICON))
          x += EICON + 4
        }
        if (tier.dots) {
          const lit = Math.min(EDOT.cols * 2, Math.round((mt.pct / 100) * EDOT.cols * 2))
          const dot = (i: number) => `<circle cx="${r3(x + EDOT.pitch / 2 + (i % EDOT.cols) * EDOT.pitch)}" cy="${r3(EDOT.rows[Math.floor(i / EDOT.cols)]!)}" r="${EDOT.r}"/>`
          const on = Array.from({ length: lit }, (_, i) => dot(i)).join('')
          const off = Array.from({ length: EDOT.cols * 2 - lit }, (_, i) => dot(lit + i)).join('')
          const mw = EDOT.cols * EDOT.pitch
          put(`<g class="trk" style="${paintBar(mt.hue)}">${off}</g>`, `<g class="bar" style="${paintBar(mt.hue)}">${on}</g>`)
          if (shines && lit > 0) {
            const name = `s${mw + SHINE_W}`
            used.set(name, `${mw + SHINE_W}px`)
            put(
              `<clipPath id="c${id}">${on}</clipPath>`,
              `<g clip-path="url(#c${id})"><rect class="sh" x="${r3(x - SHINE_W)}" y="${EC.top}" width="${SHINE_W}" height="${EC.h}" fill="url(#shine)"${anim(name)}/></g>`,
            )
          }
          x += mw + tier.inner
        }
        put(fig(mt.hue, x, mt.tokens))
        x += eTextW(mt.tokens) + 1
        put(mute(x, mt.window))
        x += eTextW(mt.window)
      } else {
        put(iconAt(x, mt.hue, TARGET_ICON))
        x += EICON + 4
        const pct = `${mt.pct}%`
        put(fig(mt.hue, x, pct))
        x += eTextW(pct)
      }
    })
    // Consecutive parts at the same share sit in one shifted group
    let body = ''
    for (let i = 0; i < parts.length; ) {
      let j = i
      let run2 = ''
      while (j < parts.length && parts[j]!.k === parts[i]!.k) run2 += parts[j++]!.s
      const kk = parts[i]!.k
      body += E && kk > 0 ? `<g style="transform:translateX(calc(${r3(kk)} * ${E}))">${run2}</g>` : run2
      i = j
    }
    return { end: x, body, used }
  }
  const { end } = lay(null)
  const E = `max(0px, 100% - ${r3(end + RIGHT_INSET)}px)`
  const { body, used } = lay(E)
  return { width: Math.ceil(end + RIGHT_INSET), body, used }
}

// The icons in currentColor, which each icon's group sets to its hue (or leaves the muted text's)
const LAYERS_ICON =
  `<g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">` +
  `<path d="M5 0.6 L9.4 2.8 L5 5 L0.6 2.8 Z" fill="currentColor" fill-opacity="0.25"/>` +
  `<path d="M0.6 5.2 L5 7.4 L9.4 5.2"/><path d="M0.6 7.2 L5 9.4 L9.4 7.2"/></g>`
const TARGET_ICON =
  `<g fill="none" stroke="currentColor" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="currentColor"/></g>`

// The markup: width 100% and no viewBox, so the webview draws it at the row's width and nothing
// in it scales (CHECKLIST #3). `fresh` is whether the single shine after a change is still due.
export const editorSvg = (m: Measure | null, t: TurnTokens | null, at: number, models: Scoped[], fresh = true) => {
  const ms = editorMetrics(m, t, at, models)
  const tiers = TIERS.map((tier, i) => editorTier(ms, tier, i, fresh))
  // Tier i shows from its own width up to the next richer tier's; the last shows below that too
  const show = tiers
    .map((tr, i) => (i === 0 ? '' : `@media (max-width:${tiers[i - 1]!.width - 0.02}px){.v${i - 1}{display:none}.v${i}{display:inline}}`))
    .join('')
  const used = new Map(tiers.flatMap(tr => [...tr.used]))
  const keys = [...used].map(([name, d]) => `@keyframes ${name}{0%{transform:translateX(0)}62%,100%{transform:translateX(${d})}}`).join('')
  const css =
    `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;font-weight:500;font-feature-settings:"tnum","cv05"}` +
    `.n{fill:currentColor}.m{fill:currentColor;fill:${MUTE};font-weight:400}` +
    `.ic{color:${MUTE}}` +
    `.bar{fill:currentColor}.trk{fill:currentColor;fill-opacity:.22}` +
    `.sep{fill:currentColor;fill-opacity:.2}.rule{fill:currentColor;fill-opacity:.12}` +
    tiers.map((_, i) => (i === 0 ? '' : `.v${i}`)).filter(Boolean).join(',') + `{display:none}` +
    show +
    keys +
    (fresh ? `@media (prefers-reduced-motion:reduce){.sh{animation:none!important}}` : '')
  const defs =
    !fresh
      ? ''
      : `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
        `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`
  const body = tiers.map((tr, i) => `<g class="v${i}">${tr.body}</g>`).join('')
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${EH}"><style>${css}</style>${defs}${body}</svg>`,
    widths: tiers.map(tr => tr.width),
  }
}

// ---- Stacking in the box above the prompt (layout/ABOVE-PROMPT.md, C1 and C2)

// VS Code's space around the row, in the box's lines (1.4 × 13px), measured by ink in the
// layout preview (the host gives 1px under its title and 4px at the bottom):
// - above: the row's first ink 7px under the host's title, which leaves it 3px under the divider
//   of a block above;
// - between: from the row's last ink to the divider's join, so the line hangs 3px under it;
//   The row's last ink is the foot of the context's `/`, 1px under the figures' baseline.
// - unspaced: under the divider, before a block beneath that brings no space of its own;
// - end: with nothing beneath, the row owns the box's bottom edge: 5px under its last ink.
export const SPACE = { above: 0.173, between: 0.122, unspaced: 0.06, end: 0.03 } as const
// The divider between two mods' blocks: 1px of the theme's prompt border color, its Box of no
// height, the line hanging DIVIDER.hang under the join
export const DIVIDER = { line: 0.055, hang: 0.044 } as const

// Whether a tree is Claude Code's own drawing, `{ type: 'engine' }`, which stands only at the root
export const isEngine = (node: unknown): boolean =>
  typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'engine'

// Whether a tree shows anything: a Box that holds nothing but empty Boxes and blank strings shows
// nothing. A drawn element keeps its children beside its props, not in them.
export const draws = (node: unknown): boolean => {
  if (node == null || typeof node === 'boolean') return false
  if (typeof node === 'string') return node.trim() !== ''
  if (Array.isArray(node)) return node.some(draws)
  if (typeof node !== 'object') return true
  const { type, children, props } = node as { type?: string; children?: unknown; props?: { children?: unknown } }
  if (type !== 'Box') return true
  return draws(children) || draws(props?.children)
}

const SIDES = {
  top: ['paddingTop', 'paddingY', 'padding', 'marginTop', 'marginY', 'margin'],
  bottom: ['paddingBottom', 'paddingY', 'padding', 'marginBottom', 'marginY', 'margin'],
} as const

// Whether a tree starts (or ends) with space of its own: a padding or margin on that side of its
// root, or of the first (last) of a column's children, as far down as the first (last) row goes
const spaced = (node: unknown, side: keyof typeof SIDES): boolean => {
  if (typeof node !== 'object' || node === null || (node as { type?: unknown }).type !== 'Box') return false
  const { props = {}, children = [] } = node as { props?: Record<string, unknown>; children?: unknown[] }
  const has = SIDES[side].some(k => {
    const v = props[k]
    return (typeof v === 'number' && v > 0) || (typeof v === 'string' && v !== '' && v !== '0')
  })
  if (has) return true
  const rows = (Array.isArray(children) ? children : [children]).filter(c => c != null && c !== false && c !== '')
  return props.flexDirection === 'column' && spaced(side === 'top' ? rows[0] : rows[rows.length - 1], side)
}
export const startsSpaced = (node: unknown) => spaced(node, 'top')
export const endsSpaced = (node: unknown) => spaced(node, 'bottom')

// The desktop app redraws the band, and its frame blinks, on every write a drawing reads. So a
// reading is only written when it changes what the band shows: a new token count that rounds to
// the same figure, or a clock tick that leaves every countdown as it was, writes nothing.
const shown = (m: Measure | null, t: TurnTokens | null, at: number, s: ScopedReading | null) =>
  desktopSvg(m, t, at, modelsAt(s, at)).svg

// In VS Code the shine crosses once after what the row shows changes, then the markup carries no
// animation, so the webview stops drawing it frame by frame
const SWEEP_MS = 3_000
const swept = async ($: EngineInterface) => {
  await update($, sweep, () => true)
  $.clock.after(SWEEP_MS, () => {
    void update($, sweep, () => false)
  })
}

const readAll = async ($: EngineInterface) =>
  [await read($, measure), await read($, turn), await read($, now), await read($, scoped)] as const

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const [m, t, was, s] = await readAll($)
  if (was && shown(m, t, was, s) === shown(m, t, at, s)) return
  await update($, now, () => at)
}

const setMeasure = async ($: EngineInterface, next: Measure) => {
  const [m, t, at, s] = await readAll($)
  if (m && shown(m, t, at, s) === shown(next, t, at, s)) return
  await update($, measure, () => next)
  await swept($)
}

const setTurn = async ($: EngineInterface, next: TurnTokens) => {
  const [m, t, at, s] = await readAll($)
  if (t && shown(m, t, at, s) === shown(m, next, at, s)) return
  await update($, turn, () => next)
  await swept($)
}

const setScoped = async ($: EngineInterface, next: ScopedReading) => {
  const [m, t, at, s] = await readAll($)
  const when = at || (await $.clock.now())
  if (s && s.at >= next.at) return
  const visible = shown(m, t, when, s) !== shown(m, t, when, next)
  await update($, scoped, () => next)
  if (visible) await swept($)
}

// Shown by the preview when the session has no reading yet
const SAMPLE_MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
}
const SAMPLE_TURN: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }

const PROFILES: { name: string; look: Look }[] = [
  { name: 'Ghostty', look: { style: 'nerd', colors: 'true' } },
  { name: 'iTerm2 / Warp / WezTerm / kitty', look: { style: 'unicode', colors: 'true' } },
  { name: 'macOS Terminal (256 colors)', look: { style: 'unicode', colors: '256' } },
  { name: 'ascii fallback', look: { style: 'ascii', colors: '256' } },
]

// Icon set override, read from USAGE_BAND_ICONS. It is an environment variable rather than a
// plugin option so a fresh install has nothing to configure.
const ICONS_ENV = 'USAGE_BAND_ICONS'

export const WELCOME =
  'usage-band is on: your 5h and 7d limits, context window and cache hit rate now show above the prompt. ' +
  'The limits fill in after Claude’s first reply.'

export const register: Register = on => {
  let setting = 'auto'
  // The terminal animates by redrawing; started by its first draw, so a session without a terminal
  // never runs it. A reload drops the timer and this flag together.
  let isAnimating = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    setting = ((await $.env.get('USAGE_BAND_ICONS')) ?? 'auto').trim().toLowerCase() || 'auto'
    const term = await $.env.get('TERM_PROGRAM')
    await update($, style, () => detectStyle(setting, term))
    await $.command.register({
      name: PREVIEW,
      description: 'Preview how the usage band looks in different terminals',
    })
    // One welcome after install, so a new user knows what appeared above the prompt
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(WELCOME, { timeoutMs: 12_000 })
    }
    const usage = await $.session.usage()
    await setMeasure($, { context: usage.context, rateLimits: usage.rateLimits })
    // The session starts without waiting on the endpoint
    void pollScoped($)
    await tick($)
    $.clock.every(60_000, () => {
      void pollScoped($).then(() => tick($))
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const m: Measure = {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
    }
    await setMeasure($, m)
    await tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; subagent runs raise their own turn.complete
    if (e.agentId === undefined && e.usage) {
      const u = e.usage
      await setTurn($, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      })
    }
    return next(e)
  })

  on('command.run', { command: PREVIEW }, async () => ({
    text: `usage-band style preview (${ICONS_ENV}: ${setting})`,
  }))

  on('ui.render', { component: 'CommandOutput', props: { command: PREVIEW } }, async ($, e) => {
    const m = (await read($, measure)) ?? SAMPLE_MEASURE
    const t = (await read($, turn)) ?? SAMPLE_TURN
    const at = await read($, now)
    const current = await read($, style)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS_ENV}: {setting} → using {current}
        </Text>
        {PROFILES.map(p => (
          <Box key={p.name} flexDirection="column" marginTop={1}>
            <Text dimColor>{p.name}</Text>
            <Box flexDirection="row">
              {layout(m, t, at, 2, 3, p.look).map((s, i) => (
                <Text key={`s${i}`} color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  // The box above the prompt is one slot that several mods share: this row goes on top, and what
  // the hooks beneath drew stays under it (C1), in VS Code past a divider line (C2). A survey keeps
  // the slot to the hooks beneath.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (e.props.hasSurvey) return theirs
    const m = await read($, measure)
    const t = await read($, turn)
    const at = await read($, now)
    const models = modelsAt(await read($, scoped), at)
    if (m === null && t === null && models.length === 0) return theirs
    // Claude Code's own placeholder is never nested: the desktop drops a band that nests it
    const below = isEngine(theirs) || !draws(theirs) ? null : theirs
    const { Box } = $.ui.resolve(e)
    let row
    if (e.surface === 'vscode') {
      const { Svg } = $.ui.resolve(e)
      const fresh = await read($, sweep)
      const { svg } = editorSvg(m, t, at, models, fresh)
      row = (
        <Box flexDirection="row" flexWrap="nowrap">
          <Box flexDirection="column" width={0} flexGrow={1} minWidth={0}>
            <Svg source={svg} alt={describe(m, t, models)} />
          </Box>
        </Box>
      )
    } else if (e.surface === 'desktop' || e.surface === 'mobile') {
      // Desktop and mobile animate inside the SVG, so they never read the frame counter
      const { Svg } = $.ui.resolve(e)
      const { svg, width, height } = desktopSvg(m, t, at, models)
      row = (
        <Box flexDirection="row" justifyContent="center" flexGrow={1} paddingX={1}>
          <Svg source={svg} alt={describe(m, t, models)} width={width} height={height} />
        </Box>
      )
    } else {
      if (!isAnimating) {
        isAnimating = true
        $.clock.every(FRAME_MS, () => {
          void update($, phase, f => (f ?? 0) + 1)
        })
      }
      const frame = await read($, phase)
      // The terminal font decides icons
      const s = await read($, style)
      const spans = fit(m, t, at, e.props.bodyColumns - 2, frame, { style: s, colors: 'true' }, models)
      const { Text } = $.ui.resolve(e)
      row = (
        <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
          {spans.map((sp, i) => (
            <Text key={`s${i}`} color={sp.color} dimColor={sp.dim}>
              {sp.text}
            </Text>
          ))}
        </Box>
      )
    }
    if (e.surface !== 'vscode') {
      // The terminal, the desktop and mobile stack the rows with no gap: the terminal has no half rows
      return below ? (
        <Box flexDirection="column">
          {row}
          {below}
        </Box>
      ) : (
        row
      )
    }
    // VS Code's box (C2): the row brings its own space above it. A block beneath is joined to it by
    // a divider in the middle of the 7px between them; the block beneath brings its own space under
    // the divider, or gets this root's when it brings none.
    return (
      <Box flexDirection="column" paddingTop={SPACE.above} {...(below ? {} : { paddingBottom: SPACE.end })}>
        {row}
        {below && (
          <Box
            flexDirection="column"
            height={0}
            marginTop={SPACE.between}
            {...(startsSpaced(below) ? {} : { marginBottom: SPACE.unspaced })}
          >
            <Box height={DIVIDER.line} marginTop={DIVIDER.hang} flexShrink={0} backgroundColor="promptBorder" />
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
