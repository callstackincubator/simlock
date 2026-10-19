# Design guide

How Simlock looks. The web console follows it today, and the landing page will
follow it when it is built. The tokens live in `ui/src/ds/foundation.css`; change
this guide and that file together.

The style is Callstack's console style, the one Apex uses: an off-white page,
square cards a shade darker, mono labels in capitals, and one accent colour.
Few words: a page says what it shows with its numbers, its statuses and its
shape, not with sentences about them.
Simlock's accent is orange where Apex's is green.

## Type

- **Geist** for titles and everything people read. **Geist Mono** for labels
  and for what people copy or compare: ids, tokens, commands, versions,
  timestamps, numbers in tables and on chart axes.
- A **label** is Geist Mono, 500, in capitals, letter-spaced `0.08em`
  (`--label-tracking`): tab names, stat card labels, table headers, buttons,
  the "By Callstack" chip. The capitals are CSS (`text-transform`); the text
  in the page stays as written, so a screen reader and a test read "Sign out",
  not "SIGN OUT".
- Both fonts are bundled with the console (`@fontsource-variable/geist`,
  `@fontsource-variable/geist-mono`, OFL-1.1). Nothing is loaded from a font
  service.
- One scale, in `rem`, from a 16px base:

  | Token | Size | Use |
  | --- | --- | --- |
  | `--text-xs` | 12px | labels, units, a row's second line, a link's count |
  | `--text-sm` | 14px | links in the sidebar, buttons, table cells, facts |
  | `--text-md` | 16px | body text, page subtitles, card and panel titles |
  | `--text-lg` | 20px | a list's title, an inspector title that is an id |
  | `--text-xl` | 28px | a page's and an inspector's title, a tile's number |
  | `--text-2xl` | 32px | the landing page's headings only |

- Weights: 400 for text, 500 for labels and big numbers, 600 for titles, 700
  for the wordmark.
- Titles and big numbers get a negative tracking (`-0.02em`). Body text has
  none.
- Line height 1.5 for text, 1.25 for titles.

## Colour

Every colour is a CSS custom property on `:root`. The light values apply by
default; the dark values replace them under `prefers-color-scheme: dark`. The
console has no theme switch of its own: it follows the system. Both themes
have the same structure; only the values change.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f8f8f7` | `#0e0e0f` | the page: off-white, or near-black |
| `--surface` | `#f1f1ef` | `#161618` | cards and panels, a shade darker than the page |
| `--field` | `#e9e9e7` | `#1e1e21` | an input's fill |
| `--chip` | `#e6e6e3` | `#232326` | the "By Callstack" chip |
| `--border` | `#dededb` | `#2b2b2f` | card edges, dividers, grid lines |
| `--border-strong` | `#85857f` | `#75757d` | an input's border, an outlined button |
| `--text` | `#111110` | `#f2f2f0` | text |
| `--text-muted` | `#5a5a55` | `#a1a1a8` | units, second lines, labels, inactive links and tabs |
| `--accent` | `#f76b15` | `#ff7a1a` | orange fills: the wordmark, filled buttons, the current page's and row's bar, the tab underline, charts |
| `--accent-hover` | `#e2560a` | `#ff9442` | a hovered filled button |
| `--on-accent` | `#111110` | `#0e0e0f` | text on an orange fill |
| `--accent-text` | `#b93d0b` | `#ff8c42` | orange as text or a line: links, the focus ring |
| `--selection` | `#fed7aa` | `#7c2d12` | selected text |

Orange comes in two strengths. `--accent` is bright, for fills, and carries
dark text. It is too light to be text on the page in the light theme, so
links and the focus ring use `--accent-text`, which passes AA there.

### Orange is for brand and interaction only

Use the accent the way Apex uses its green: the wordmark's block, the current
page's bar in the sidebar, the chosen row's bar, the current tab's underline,
filled buttons, links, the focus ring, selection, and the line or columns of a
chart. Never use it to say something about state: not
for "busy", not for "warning", not for "new". A reader who sees orange should
think "this is Simlock" or "I can act here", nothing else.

### Status colours

| Token | Light | Dark | Means |
| --- | --- | --- | --- |
| `--status-ok` | `#15803d` | `#4ade80` | healthy, connected, ready |
| `--status-warn` | `#92570a` | `#facc15` | needs a look soon: drained, stalled, over a limit, absent (a physical device that is enrolled and not there) |
| `--status-error` | `#b91c1c` | `#f87171` | broken: disconnected, incompatible, quarantined, a refused sign-in |
| `--status-idle` | `#57534e` | `#a8a29e` | neither: shut down, waiting, unknown |

One more fill is a neutral, not a status: `--slot-leased` (`#3f3f3b` light,
`#d6d6d0` dark), for a leased device's slot and a share of leased capacity. A
leased device is neither healthy nor in trouble; it is in use.

**A status always has a word.** The colour is a second signal, never the only
one. Use the daemon's own word for the state (`leased`, `quarantined`,
`drained`), so the console and the CLI agree. In the console a status is an 8px
square of its colour, then the word in `--text` (`Status` in
`ui/src/ds/status.tsx`). In a list row, where there is room for the square
alone (`StatusDot`), the word is the square's accessible name and its tooltip,
and the chosen row's inspector shows it in full. A worker's square shows the
worst of what is wrong with it: red for a lost or failed worker, amber for a
drained or starting one, one over its RAM budget, or a load figure past its
threshold, green otherwise (`workerHealth` in `ui/src/model/fleet.ts`). A word
the console does not know, from a newer daemon, shows as itself in
`--status-idle`. A count, such as the one on the Attention link, is a number,
not a status: it has neither a status colour nor the accent.

Every pair of text and background colour in both themes meets WCAG AA: 4.5:1
for text, and 3:1 for the focus ring and an input's border against what is
behind them. The browser lane checks text contrast with axe in both themes; a
new token must pass it too.

## Shape

- **Square corners** everywhere: `--radius` is `0`. No rounded buttons, cards
  or inputs.
- Borders are 1px. Cards are `--surface` with a `--border` edge, no shadow.
- No gradients, no illustrations. The decoration is the wordmark's orange
  block, and the faint orange fill under a chart's line.

## Spacing

A 4px grid: `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4`
16px, `--space-6` 24px, `--space-8` 32px, `--space-12` 48px. Pick from the
scale; never a value between.

- Buttons and inputs are at least 40px tall, so they are easy to hit on a phone.
- A page has 16px side padding on a phone and 24px from 768px up.
- Cards sit 16px apart. Inside a card, 24px from its sides.

## Components

The components live in `ui/src/ds/` (the design system); `ui/AGENTS.md` lists them. A screen is
put together from them and draws nothing of its own that one of them already draws.

- **Sidebar.** The console's navigation, on the left of every signed-in page: the "SIMLOCK"
  wordmark (`--on-accent` on an `--accent` block), one link per page in a fixed order (Overview,
  Workers, Leases, Waiting, Attention, Events, Usage), then at the bottom the connection as a status,
  **Sign out** and the collapse button. A link is an icon and its label in `--text-muted`; the
  current one is `--text` on `--field` with a 2px `--accent` bar on its left and
  `aria-current="page"`. Attention carries its count in a small bordered box, and none at zero.
  Collapsed, the sidebar is 64px wide: the labels go, every icon sits on its centre line, each
  link keeps its name (and a tooltip), the wordmark becomes "S" and the connection its square.
  Only the operator collapses or widens it, with the button at its bottom; the browser keeps the
  choice, and changing pages never changes it. With no choice made, a window under 1280px starts
  it collapsed. Under 768px it is a bar along the top: the wordmark and a **menu** button that
  opens the links and the bottom block under it.
- **Page.** A page that is not a list, as the overview: its title (`h1`) and its actions on the
  right, then its content. No subtitle: the title and what is under it say what the page is.
- **List and inspector.** Every page of things (workers, leases, waiting requests, attention
  items, events) is a list on the left, 260–360px wide (wider for events), and the chosen thing in
  an inspector filling the rest. The list has a header (the page's title as `h1`, a short count
  in mono beside it, then its filters), its rows, and the pager under them. A row is one or two
  short lines: a status square, a title, one figure on the right, and at most one muted line or
  bar under them; the chosen row is `--surface` with a 2px `--accent` bar on its left and
  `aria-current="page"`. The address names the chosen thing (`/workers/<id>`). The inspector
  has a breadcrumb, the thing's title (`h2`), one muted line under it, actions on the right, and
  then cards, facts, tabs and panels.
- **Stat tiles.** A row of tiles: a label, a big number (`--text-xl`), and a short unit in mono
  beside it ("of 48", "last hour"). A tile that leads somewhere is a link as a whole. A tile
  shows only numbers its page already has; it never makes a request of its own.
- **Panel.** A card with a header: a title and, on the right, its actions. No description: a
  panel's title says what it holds. A panel is a region named by its title.
- **Facts.** A label and its value side by side, the label as a label. Facts that show a
  payload keep the keys as the daemon spelled them (`leaseId`), in mono, not in capitals.
- **Filters.** A row of chips, one choice of several: a radio group drawn as small mono boxes,
  the chosen one filled `--field` with a `--border-strong` edge.
- **Tabs.** Labels in a row over a 1px `--border` line; the current one `--text` with a 2px
  `--accent` underline.
- **Slots.** One square per device a worker may run, shaded by what the device is doing:
  leased (a neutral fill, `--slot-leased`), ready (`--status-ok`), booting (`--status-idle`),
  quarantined (`--status-error`), absent (`--status-warn`), free (a dashed `--border-strong`
  outline). A group of slots carries its counts as words in its accessible name ("2 leased, 1
  ready, 3 free") and each square its device in a tooltip; a legend names the shades.
- **Table.** Fills its panel edge to edge. Headers are labels in
  `--text-muted`. Rows are roomy, 16px above and below, with a 1px line
  between them. Numbers, durations included, are mono and right-aligned.
  Every table of a page's items is the one table component
  (`ui/src/ds/table.tsx`), so every such table pages the same way. A chart's
  table is not one: it has one row per bucket, always.
- **Pager.** Under a table, edge to edge in its panel, with a 1px `--border`
  line above it like a row's: the rows shown of how many in mono (`26–50 of
  1,240`), **Per page** as a select, then **Previous**, the page number in
  mono `--text-muted` (`Page 2 of 50`), and **Next**, as secondary buttons.
  It wraps on a phone. Under a list it sits in the list's footer, its parts
  stacked to fit the list's width. It is hidden when every row fits
  on one page. At either end, the button that would leave the list keeps its
  place and its focus, says so with `aria-disabled`, and goes quiet: its text
  `--text-muted`, its edge `--border`.
- **Scroll box.** A long feed, such as the events, scrolls inside a box of
  fixed height, `min(40rem, 70vh)`, edge to edge in its panel with a 1px
  `--border` line above it; the page does not scroll with it. The box takes
  focus, with its focus ring inside its edge, so the keyboard can scroll it.
  Only the rows in view are drawn. A count of what arrived while the reader
  was scrolled down ("3 new events") is a secondary button on `--bg`,
  centred over the top of the box. It is outlined, not orange: orange never
  says "new".
- **Long ids** (a lease's, a worker's, a device's) stay on one line, cut with
  an ellipsis. The whole id is in the element's `title`, in the text a copy or
  a screen reader reads, and on the details page.
- **Buttons.** Primary: filled `--accent` with `--on-accent` text. Secondary:
  outlined in `--border-strong`, `--text`. Quiet: text only. All are labels.
- **Inputs.** A `--field` fill and a 1px `--border-strong` border. A select is
  the same, 40px tall, in mono, with the browser's own arrow turned off
  (`appearance: none`): it draws a small chevron in `--text`, two CSS
  gradients 12px in from its right edge, and 32px of right padding keep its
  value clear of it. It looks the same in every browser and both themes, and
  needs no image, which the CSP would refuse.
- **Charts.** Drawn with Recharts, bundled like the rest. A line or columns in
  `--accent`, an area with a faint fill of it (8%), horizontal grid lines in
  `--border`, axis labels in Geist Mono `--text-muted`. Every colour comes from
  the stylesheet by class. Nothing moves: animation is off. Every chart has a
  title saying what it counts, its numbers as a line of text under it, and every bucket as a table behind a disclosure named by the bucket width ("Minute by minute", "Every 5 minutes", "Hour by hour"), so
  nothing is visible only in the picture. A chart can be focused, and the
  arrow keys step through it. Its focus ring goes round the whole chart, for
  keyboard focus only: a click on a chart draws none.
- **Meters.** A bar under or beside a figure it shades: `--field` track, square, never the
  accent. Its fill takes a status colour by class, or a neutral one; its level arrives inline as
  a CSS custom property: `style-src 'self'` refuses a style attribute in markup, and the level
  arrives anyway because React writes styles through the CSSOM, where the policy does not reach.
  ADR 0011 allows the `style` prop because it creates no `<style>` element. A meter is never the
  only place its number is, so it carries no accessible name and takes no focus. A load figure —
  CPU, memory, disk — takes `LOAD_THRESHOLDS` from `ui/src/model/load-thresholds.ts`: amber at
  85% full, red at 95%, neutral below, the current reading only; where the worker sends a memory
  pressure, that word decides memory's colour instead. A worker sends no thresholds, so these are
  the console's opinion alone and `simlock status` reports the same figures without one.

## Layout

- Phone first. Every page works at 360px wide with no sideways scrolling of the page. Under 768px
  the sidebar is a bar on top with a menu, and a list page shows its list until something is
  chosen and the inspector after (the address says which). Under 768px a table's rows stack into
  blocks, each cell a line with its column's name beside it (`data-label`). A wide table, of six
  columns or more, stacks the same way under 1100px. Otherwise a table has a fixed layout: a
  column of numbers is 8rem wide, the others share the rest, and a long cell wraps or, for an id,
  is cut, so a table is never wider than its panel.
- Stat tiles fill the row, each at least 170px wide, and wrap.
- From 1024px a chart and the panel beside it share a row, two thirds and one third; two panels
  of the same weight share it half and half.
- A list page with nothing in its address shows its first row in the inspector on a wide screen.

## Focus and keyboard

- Everything clickable is a real `<a>`, `<button>` or `<summary>`, so it is
  reachable with Tab and works with Enter.
- The focus ring is a 2px `--accent-text` outline, 2px off the element. It shows
  for keyboard focus (`:focus-visible`), not on a mouse click.
- The first control on every signed-in page is "Skip to content", visible only
  when focused.

## Motion

Short, and only where it says where something came from. Colour changes on hover take 120ms
(`--duration`). Moves take 220ms (`--duration-move`) on one easing (`--ease`): the sidebar
widens and narrows; a page rises 10px as it opens; a list slides in from the left and an
inspector from the right, again each time another thing is chosen; the chosen row's bar and a
meter or share bar slide to their new place. Nothing loops, nothing moves on its own, and
charts never animate. With `prefers-reduced-motion: reduce`, there are no transitions and no
animations at all.

## Voice

- Short, plain sentences. Say what happened and what to do next.
- Name things the way the CLI does: worker, lease, device, token, gateway.
- Errors say what is wrong, not that something "went wrong": "The daemon
  cannot be reached." Never blame the reader.
- No exclamation marks, no emoji, no "please", no "oops".
- Buttons are verbs: "Sign in", "Sign out".
- Fewer words beat more. No subtitles under page titles, no descriptions under
  panel titles, no column that repeats one value on every row. A figure's unit
  is a word or two in mono beside it ("of 48", "last hour").
- An empty or unfinished page says so in one line: "Coming soon.", "No leases."
