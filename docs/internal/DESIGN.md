# Design guide

How Simlock looks. The web console follows it today, and the landing page will
follow it when it is built. The tokens live in `ui/src/styles.css`; change this
guide and that file together.

The style is Callstack's console style, the one Apex uses: an off-white page,
square cards a shade darker, mono labels in capitals, and one accent colour.
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
  | `--text-xs` | 12px | labels on cards and tables, the chip, a tab's count |
  | `--text-sm` | 14px | tabs, buttons, captions, descriptions, table cells |
  | `--text-md` | 16px | body text, page subtitles, card and panel titles |
  | `--text-lg` | 20px | the wordmark |
  | `--text-xl` | 28px | a page's title (`h1`), a stat card's number |
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
| `--text-muted` | `#5a5a55` | `#a1a1a8` | subtitles, captions, labels, inactive tabs |
| `--accent` | `#f76b15` | `#ff7a1a` | orange fills: the wordmark, filled buttons, the tab underline, charts |
| `--accent-hover` | `#e2560a` | `#ff9442` | a hovered filled button |
| `--on-accent` | `#111110` | `#0e0e0f` | text on an orange fill |
| `--accent-text` | `#b93d0b` | `#ff8c42` | orange as text or a line: links, the focus ring |
| `--selection` | `#fed7aa` | `#7c2d12` | selected text |

Orange comes in two strengths. `--accent` is bright, for fills, and carries
dark text. It is too light to be text on the page in the light theme, so
links and the focus ring use `--accent-text`, which passes AA there.

### Orange is for brand and interaction only

Use the accent the way Apex uses its green: the wordmark's block, the current
tab's underline, filled buttons, links, the focus ring, selection, and the
line or columns of a chart. Never use it to say something about state: not
for "busy", not for "warning", not for "new". A reader who sees orange should
think "this is Simlock" or "I can act here", nothing else.

### Status colours

| Token | Light | Dark | Means |
| --- | --- | --- | --- |
| `--status-ok` | `#15803d` | `#4ade80` | healthy, connected, ready |
| `--status-warn` | `#a16207` | `#facc15` | needs a look soon: drained, stalled, over a limit |
| `--status-error` | `#b91c1c` | `#f87171` | broken: disconnected, incompatible, quarantined, a refused sign-in |
| `--status-idle` | `#57534e` | `#a8a29e` | neither: shut down, waiting, unknown |

**A status always shows a word.** The colour is a second signal, never the only
one: `● connected`, not a green dot. Use the daemon's own word for the state
(`leased`, `quarantined`, `drained`), so the console and the CLI agree. In the
console a status is an 8px square of its colour, then the word in `--text`
(`Status` in `ui/src/status.tsx`). A word the console does not know, from a
newer daemon, shows as itself in `--status-idle`. A count, such as the one on
the Attention tab, is a number, not a status: it has neither a status colour
nor the accent.

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

- **Header.** Left: the "SIMLOCK" wordmark, `--on-accent` on an `--accent`
  block, then the "By Callstack" chip. Right: the connection in a bordered box,
  as a status (its word and its colour), then **Sign out** as a secondary
  button. The sign-in screen has the same header, without the right side.
- **Tab bar.** Under the header, one tab per view in a fixed order: Workers,
  Leases, Waiting, Attention, Events. A tab is a label in `--text-muted`; the
  current one is `--text` with a 2px `--accent` underline and
  `aria-current="page"`. A 1px `--border` line runs under the bar. Attention
  carries its count in a small bordered box, and none at zero.
- **Page header.** The view's title, a one-line subtitle in `--text-muted`
  under it, and the view's actions on the right, such as **All workers** on a
  worker's page.
- **Stat cards.** A row of cards under the page header: a label, a big number
  (`--text-xl`), and a caption in `--text-muted` saying what it counts. A
  card shows only numbers the view already has; it never makes a request of
  its own.
- **Panel.** A card with a header: a title, a description in
  `--text-muted`, actions on the right, and a 1px line between the header and
  its body. A table, a chart or a list sits in a panel. A panel is a region
  named by its title.
- **Table.** Fills its panel edge to edge. Headers are labels in
  `--text-muted`. Rows are roomy, 16px above and below, with a 1px line
  between them. Numbers, durations included, are mono and right-aligned.
  Every table of a view's items is the one table component
  (`ui/src/table.tsx`), so every such table pages the same way. A chart's
  "Minute by minute" table is not one: it always has its 60 rows.
- **Pager.** Under a table, edge to edge in its panel, with a 1px `--border`
  line above it like a row's: the rows shown of how many in mono (`26–50 of
  1,240`), **Per page** as a select, then **Previous**, the page number in
  mono `--text-muted` (`Page 2 of 50`), and **Next**, as secondary buttons.
  It wraps on a phone. Under a grid of cards it is a bar of its own, a
  `--surface` card with a `--border` edge. It is hidden when every row fits
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
  title, a caption saying what it counts, its numbers as a line of text under
  it, and every minute as a table behind a "Minute by minute" disclosure, so
  nothing is visible only in the picture. A chart can be focused, and the
  arrow keys step through it. Its focus ring goes round the whole chart, for
  keyboard focus only: a click on a chart draws none.

## Layout

- Phone first. Every page works at 360px wide with no sideways scrolling of the
  page. When the tabs do not fit, as on a phone, the tab bar scrolls sideways inside itself. Under 768px a
  table's rows stack into blocks, each cell a line with its column's name
  beside it (`data-label`). A wide table, of six columns or more, stacks the
  same way under 1100px. Otherwise a table has a fixed layout: a column of
  numbers is 8rem wide, the others share the rest, and a long cell wraps or,
  for an id, is cut, so a table is never wider than its panel.
- Stat cards fill the row, each at least 200px wide, and wrap.
- From 768px a chart and the panel beside it share a row, two thirds and one
  third; two panels of the same weight share it half and half.
- A list of things that each carry several facts, such as workers, is a grid
  of cards, each a title and its facts as label and value pairs. It pages at
  24, 48 or 96 cards, whole rows of the grid at two, three or four columns.

## Focus and keyboard

- Everything clickable is a real `<a>`, `<button>` or `<summary>`, so it is
  reachable with Tab and works with Enter.
- The focus ring is a 2px `--accent-text` outline, 2px off the element. It shows
  for keyboard focus (`:focus-visible`), not on a mouse click.
- The first control on every signed-in page is "Skip to content", visible only
  when focused.

## Motion

Almost none. Colour changes on hover take 120ms (`--duration`). Nothing slides,
fades or bounces, charts included. With `prefers-reduced-motion: reduce`, there
are no transitions at all.

## Voice

- Short, plain sentences. Say what happened and what to do next.
- Name things the way the CLI does: worker, lease, device, token, gateway.
- Errors say what is wrong, not that something "went wrong": "The daemon
  cannot be reached." Never blame the reader.
- No exclamation marks, no emoji, no "please", no "oops".
- Buttons are verbs: "Sign in", "Sign out".
- A subtitle or a caption says what is shown, in one line: "Every worker in
  the fleet: its connection, its devices and its leases."
- An empty or unfinished page says so in one line: "Coming soon.", "No leases."
