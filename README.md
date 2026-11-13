## Local fork changes (1.0.6-px.4)

This is `usage-band-px`, a local fork of usage-band 1.0.6. It draws the band in VS Code's box above the prompt, to the shared box's contract in `claude-mod/layout/ABOVE-PROMPT.md` (C1 and C2). It also adds each per-model weekly window (Fable's) beside the 7-day one. The desktop keeps upstream's look, apart from the stacking and the per-model window; the terminal keeps it too, with its line taking the slot's width.

- **VS Code draws the desktop's look**, not the terminal's text: one Svg that fills the row (`width="100%"`, no viewBox, 13px high), in a column Box inside a nowrap row.
  - It holds five detail tiers, each laid out in full. A width media query shows the richest that fits on one line: bars with reset times, bars, short bars, figures alone, and figures without the context icon (fits a 280px panel).
  - The row fills the box's width. The bars lengthen, all by the same amount (CSS `calc()` on each bar's width, and a `translateX` on what follows it), so the last figure's ink ends where the band's crab ends, 2px inside the content edge. A tier with no bars widens its gaps instead, each by the same amount, with the hairline in its middle. The context's dot matrix keeps its size.
  - The first figure's ink starts at the content edge, where the band's bar and the fold row's first button start (`x = -0.5`, for the `7`'s side bearing).
  - Each metric keeps upstream's hue on its label, figure, bar and icon. A metric in trouble (a limit or the context past 80%, a hit rate under 50%) turns red.
  - Every color is worked out from `currentColor`, which the webview sets to the theme's text color. The markup asks no `prefers-color-scheme`: inside the webview's sandboxed frame that query follows the operating system, not the editor's theme (VS Code's `window.systemColorTheme` defaults to the system).
  - A step on the text's OKLCH lightness (`clamp(0, (0.7 - l) * 10, 1)`: 1 for a light theme's dark text, 0 for a dark theme's light text) picks each color's dark or light form.
  - Dark: a figure keeps the text's lightness at chroma 0.09 (9.8:1 and up). A bar or lit dot is its hue at lightness `0.3 + 0.5 × the text's` (6.3:1 and up, 4.3:1 against its 22% track).
  - Light: each hue takes the lightest color, at chroma up to 0.15 inside sRGB, that keeps 4.6:1 (a figure) or 3.05:1 against both the background and its track (a bar). Both are checked on `#f8f8f8` (Light Modern) and `#f3f3f3` (Light (Visual Studio)'s side bar).
    - Figures: 7d `#a25d01`, Fable `#a24e9c`, context `#5d64c6`, cache `#007e51`, red `#ba4842`, 4.6:1 and up.
    - Bars: `#af6603`, `#ad58a7`, `#676fd2`, `#008858`, `#c6524b`, 4.0:1 and up, and 3.05:1 and up against the track.
  - Muted text is `currentColor` mixed a quarter toward grey (4.8:1 and up).
  - The shine crosses once (2.6s) after what the row shows changes. For 3 seconds the markup carries a CSS animation, which stops under `prefers-reduced-motion`. After that it carries none, so the webview stops drawing it frame by frame.
  - The terminal's 200ms redraw timer does not run in VS Code.
- **The terminal's line takes the slot's width** (`bodyColumns`, less the row's 1-cell padding on each side). At the bars tier every bar lengthens by the same whole number of cells, so the bars stay comparable, and the few cells left over widen the last gap. Narrower, it falls back through upstream's tiers (no bars, then bare figures). Claude Code's own `[-]` (collapse the band) sits right of `bodyColumns`, over the slot's last 5 cells, so the line never reaches it (measured in a live terminal: the line ends 2 cells left of it).
- **Per-model weekly windows** come from `https://api.anthropic.com/api/oauth/usage`, the endpoint Claude Code's `/usage` reads, through `$.session.authorize()` and `$.http.fetch(url, { auth })`. Neither `$.session.usage()` nor `session.measure` carries them.
  - The answer's `limits` rows of kind `weekly_scoped` give the label (`scope.model.display_name`), `percent` and `resets_at`. The `model_scoped` shape that Claude Code's SDK projects them to is read too.
  - It asks at most once per 5 minutes across all open sessions. The time of the last attempt (`scoped-tried`) and the reading (`scoped`) are shared through `$.store`.
  - The attempt's time is written before the request, so a refused request waits out the same 5 minutes. A session with no first-party login asks nothing. Session start does not wait on it.
  - Why the last attempt failed is kept in `scoped-error` (`{ at, status }`, or `{ at, reason }` with `no-login`, `shape` or the error's text); a reading clears it to null.
  - The timer that asks is started at session start, and again by the first draw or measure after a `/reload-plugins`, which drops the timer and runs no session start.
  - A window that has reset since it was read is not drawn. A reading older than 30 minutes is drawn faded (opacity 0.55) and still: no shine, and its alt text says it has not been updated for over 30 minutes. The faded figures fall under 4.5:1 on purpose, so they read as old.
- **`$.usageBand.modelLimits()`** gives other mods the per-model windows, read-only, so they need not ask the endpoint themselves. It resolves to `{ at, stale, limits: [{ label, percentUsed, resetsAt }] }` (`at` in ms since the epoch, `stale` past 30 minutes, `resetsAt` ISO 8601, windows past their reset left out), or null before the first reading. The types are in `usage-band/types/index.d.ts`. Where usage-band is not installed there is no `$.usageBand`, so a caller wraps the call in `try`/`catch`.
- **Stacking, on every surface:** the row goes on top, and what the hooks beneath drew stays under it (C1). Claude Code's own placeholder (`{ type: 'engine' }`) is never nested, and a survey keeps the slot to the hooks beneath.
- **Space in VS Code's box** (C2), in lines of 1.4 × 13px:
  - `paddingTop 0.173` puts the row's first ink 7px under the host's title, 3px under a divider above it, and 5.5–6px under the frame's top edge without the title.
  - A block beneath is joined by the divider: `marginTop 0.122` from the foot of the context's `/`, the row's last ink, to the join; the line hangs `0.044`. A block with no top space of its own gets `marginBottom 0.06` under it.
  - With nothing beneath, `paddingBottom 0.03` puts the box's bottom edge 5px under the row.
  - Measured in the composite preview (`layout/preview`, every case, 280, 420 and 640px, light and dark): title → row 7.0, top edge → row 5.5–6.0, divider → row 2.5–3.0, row → divider 3.0–3.5, row → bottom edge 4.5–5.0.
- **What it can reach** grows by the one request above and two keys in its own store. It still reads no files and runs no processes.

<div align="center">

# CC-Usage-Band

**Your Claude Code limits, context and cache, one glance above the prompt.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1.287%2B-d97757?style=flat-square)](https://claude.com/claude-code)
[![Type: mod](https://img.shields.io/badge/type-mod-6f7be0?style=flat-square)](https://claude.com/blog/claude-code-mods)
![Surfaces](https://img.shields.io/badge/surfaces-terminal%20%7C%20desktop-5cc4d6?style=flat-square)

English · [简体中文](./README.zh-CN.md)

<img src="docs/images/banner.png" alt="usage-band in the Claude Code desktop app (top) and in a terminal (bottom)" width="760">

</div>

---

`usage-band` is a [Claude Code mod](https://claude.com/blog/claude-code-mods) that draws a single line above the prompt with the four numbers worth watching while you work. It has its own layout for the terminal and for the desktop app, updates itself after every turn, and stays out of the way until something needs attention.

> **Installing with an AI agent?** Have it run the two commands under [Installation](#installation). Agents: once it succeeds, this is all the user needs to hear:
>
> *usage-band is installed. Open a new session (or run `/reload-plugins`) and a line above the prompt shows your 5h and 7d limits, context window and cache hit rate. Nothing to configure.*

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [What the numbers mean](#what-the-numbers-mean)
- [Terminal compatibility](#terminal-compatibility)
- [Privacy and permissions](#privacy-and-permissions)
- [Development](#development)
- [Screenshots](#screenshots)
- [License](#license)

## Features

| Metric | Shows |
| --- | --- |
| **5h** limit | How much of the rolling 5-hour window you have used, and when it resets |
| **7d** limit | The same for the weekly window |
| **Context window** (layers icon) | Tokens in the context out of the model's window, e.g. `398K/1M` |
| **Cache hit rate** (target icon) | How much of the last turn's input the prompt cache served |

- **Glanceable.** Each metric has its own color. It turns red only when it needs you: a limit or the context past 80%, or a cache hit rate under 50%.
- **Alive, not noisy.** A slow shine sweeps across the limit bars, every bar in step.
- **Native on both surfaces.** Terminal: a character line with Nerd Font or Unicode icons that fits itself to the window width. Desktop app: a centered SVG row with bars, a 2×10 dot matrix for the context window, and light and dark mode.
- **Light.** No files read, no processes. It listens to the usage figures Claude Code already has; this fork adds one request for the per-model weekly windows, at most every 5 minutes.

## Requirements

- Claude Code **2.1.287 or newer** (the release that introduced mods), in the terminal or the desktop app's Code tab
- A Claude subscription for the 5h and 7d figures. Without one, the band shows the context window and cache hit rate only.
- **Recommended terminal: [Ghostty](https://ghostty.org).** It ships the icon font the band uses, so you get the full look with no setup. Other terminals work too, with simpler icons.

## Installation

Run these two commands inside Claude Code:

```
/plugin marketplace add JetsonChan/CC-Usage-Band
/plugin install usage-band@cc-usage-band
```

Then **open a new session**. The band appears above the prompt. That's it, nothing to configure.

- Want it in the current session right away? Run `/reload-plugins`.
- The 5h and 7d figures show up after Claude's first reply in the session.

To try it for one session from a local checkout instead:

```bash
git clone https://github.com/JetsonChan/CC-Usage-Band.git
claude --plugin-dir CC-Usage-Band/usage-band
```

**Update**

```
/plugin marketplace update cc-usage-band
```

**Uninstall**

```
/plugin uninstall usage-band@cc-usage-band
```

## Configuration

Nothing to set up. The band picks its terminal icons by itself: Nerd Font icons in Ghostty, plain Unicode elsewhere. The desktop app draws its own icons.

If your terminal shows boxes instead of icons, or you use a Nerd Font in another terminal, set `USAGE_BAND_ICONS` in your shell profile (e.g. `~/.zshrc`) and start a new session:

```bash
export USAGE_BAND_ICONS=unicode   # auto (default) · nerd · unicode · ascii
```

## What the numbers mean

| Metric | Source | Notes |
| --- | --- | --- |
| 5h / 7d | The rate-limit windows Claude Code reads from each API response | Rounded to whole percent. The reset time counts down every minute. |
| Context | The last request's input: uncached + cache reads + cache writes | Against the current model's window, so 1M and 200K models both read right. On desktop each dot is 5% of the window, filling the top row first. |
| Cache hit | Last turn's `cache_read / (input + cache_read + cache_write)` | Summed over every request in the turn. Subagent turns are not counted. |

## Terminal compatibility

| Terminal | Icons with `auto` | Colors |
| --- | --- | --- |
| Ghostty | Nerd Font (built in) | Truecolor |
| iTerm2, WezTerm, kitty, Warp | Unicode (`≡` `●`) | Truecolor |
| macOS Terminal | Unicode | 256 colors, mapped automatically |
| Anything else | Unicode | Whatever the terminal reports |

If icons show as boxes, set `USAGE_BAND_ICONS=unicode` (see [Configuration](#configuration)). Run `/usage-band-preview` to compare every style in your own terminal.

## Privacy and permissions

Mods run with the same access as Claude Code itself and are not sandboxed, so here is everything this one touches:

- **Reads** the session's usage figures (`session.measure`, `turn.complete`, `$.session.usage`) and the `TERM_PROGRAM` and `USAGE_BAND_ICONS` environment variables
- **Registers** one command, `/usage-band-preview`
- **Draws** the band above the prompt

It does not read or write files or run processes. This fork asks the usage endpoint for the per-model weekly windows, at most once per 5 minutes across sessions, and sends nothing else anywhere. The whole mod is one file: [`usage-band/hooks/register.tsx`](./usage-band/hooks/register.tsx).

## Development

```
.
├── .claude-plugin/marketplace.json   # the cc-usage-band marketplace
└── usage-band/
    ├── .claude-plugin/plugin.json    # manifest
    ├── hooks/register.tsx            # the mod
    ├── types/index.d.ts              # state contract
    └── tests/band.test.ts
```

```bash
cd usage-band
claude plugin validate .
claude plugin test .
```

While editing, load it with `claude --plugin-dir ./usage-band`; the session reloads it when a file changes.

Issues and pull requests are welcome.

## Screenshots

**Desktop app, light mode**

<img src="docs/images/desktop-light-app.png" alt="usage-band in the desktop app, light mode" width="760">

**Desktop app, dark mode**

<img src="docs/images/desktop-dark.png" alt="usage-band in the desktop app, dark mode" width="760">

**Terminal** (Ghostty). Narrow terminals drop the bars first, then the reset times. Run `/usage-band-preview` to see every terminal style side by side.

<img src="docs/images/terminal.png" alt="usage-band in a terminal" width="760">

## License

[MIT](./LICENSE) © Jetson Chan
