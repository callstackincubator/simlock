# Design guide

How the web console looks. The reference is the set of renders in
[console-redesign/renders/](console-redesign/renders/) and the prototype that
draws them, [console-redesign/prototype/d.mjs](console-redesign/prototype/d.mjs):
apart from the explicit Fleet, Baselines, sidebar-control and WCAG-AA
reference amendments below,
when this guide and a render disagree, the render wins and this guide gets
fixed. The tokens live in `ui/src/ds/foundation.css`; change this guide and
that file together. The website and every other brand visual follow
[BRAND.md](BRAND.md) instead.

The look is a dark control room: a near-black page, floating cards with
rounded corners and a thin border, mono labels in capitals, status as pills,
and one orange accent for brand and interaction. Few words: a page says what
it shows with numbers, statuses and shape, not with sentences about them.

## Type

- **Geist** for everything people read. **Geist Mono** for labels and for
  what people copy or compare: ids, holders, hostnames, versions, timestamps,
  durations, counts, chart axes. Both bundled (`@fontsource-variable/*`).
- A **label** is Geist Mono 500 in capitals, tracked `0.08em`: card headers,
  table headers, tab names and group labels in the sidebar. The
  capitals are CSS (`text-transform`); the text stays as written.
- Scale, in `rem` from a 16px base:

  | Token         | Size   | Use                                                   |
  | ------------- | ------ | ----------------------------------------------------- |
  | `--text-2xs`  | 10.5px | labels, `kbd`, counts in a sidebar badge              |
  | `--text-xs`   | 11.5px | pills, a row's second line, a card header's right text |
  | `--text-sm`   | 12.5px | table cells, list rows, facts, buttons                |
  | `--text-md`   | 13px   | body, nav links, group headers                        |
  | `--text-lg`   | 15px   | an inspector's or holder's title (mono)               |
  | `--text-xl`   | 21px   | a page title                                          |
  | `--text-2xl`  | 28px   | a KPI's number, a countdown (mono)                    |

- Weights: 400 text, 500 labels, names and buttons, 600 titles and big
  numbers, 700 the wordmark. Titles and big numbers track `-0.02em`
  (`-0.03em` at 28px). Line height 1.45 for text, 1 for anything in a
  fixed-height box (pill, button, badge).
- Tabular numbers everywhere (`font-feature-settings: "tnum"`).

## Colour

Every colour is a custom property on `:root`. Dark is the designed theme and
the one the renders show. The light theme keeps the same structure with its
own values (an off-white page, near-white cards, the same accent) and is
captured at 1440×900 in `docs/internal/console-redesign/current/light/` by
`pnpm console:screenshots`;
the axe check in `browser-checks.spec.ts` runs in both.

| Token             | Dark      | Use                                                       |
| ----------------- | --------- | --------------------------------------------------------- |
| `--bg`            | `#0c0c0e` | the page, an input's fill, the account box                |
| `--surface`       | `#141416` | cards, the sidebar                                        |
| `--surface-2`     | `#1b1b1f` | table headers, group rows, a filter group's track, a box inside a card |
| `--border`        | `#232327` | card edges, dividers, grid lines                          |
| `--border-strong` | `#75757d` | a button's or `kbd`'s edge, a free slot's dashed outline  |
| `--text`          | `#ececea` | text                                                      |
| `--text-muted`    | `#8e8e97` | units, second lines, labels, inactive links and tabs      |
| `--accent`        | `#ff7a1a` | orange fills: wordmark block, primary button, tab underline, selected row's bar, a chart's line and its hot bar, a checked facet |
| `--accent-text`   | `#ffa061` | orange as text: the current nav link, links, the focus ring |
| `--nav-current`   | `#2a2016` | the current nav link's fill                               |
| `--row-selected`  | `#221913` | the selected table row's fill                             |
| `--track`         | `#26262b` | a meter's or ring's track                                 |
| `--slot-leased`   | `#d6d6d0` | a leased slot, a meter's neutral fill, a chart's bars     |
| `--status-ok`     | `#4ade80` | healthy, connected, ready, live                           |
| `--status-warn`   | `#facc15` | needs a look soon: drained, stale, over a limit, absent   |
| `--status-error`  | `#f87171` | broken: disconnected, quarantined, failed                 |
| `--status-idle`   | `#a8a29e` | neither: shut down, waiting, unknown, booting             |

Orange is brand and interaction only, never a state. A status always has a
word, drawn as a **pill** (below); the colour is the second signal. Use the
daemon's own word (`leased`, `drained`, `stale`). A count is a number, not a
status: the Inbox badge is the one exception, red because it counts problems.

Tinted fills derive from the status colours: a pill's background is its
colour at 13% (error 15%), an attention card's border is the colour mixed
into `--border`, a warning or error row or tile is the colour at about 6%
over `--surface` (`#17140c` warn, `#19100f` error). Agent chips have their own
tints: claude `#3a2a18`/`#f5c08a`, codex `#1d2d3b`/`#9cc4e6`, cursor
`#2a2440`/`#bdb1ea`, pi `#1c3022`/`#9ad6ae`, unknown `#24242a`/`#b9b9c2`.

Every text and background pair meets WCAG AA (4.5:1 text, 3:1 rings and
edges); the browser lane checks it with axe.

## Shape and space

- Radius: `--radius` 10px for cards and the sidebar, 8px for buttons,
  inputs, chips and nav links, 99px for pills and badges.
- Borders 1px `--border`; no shadows except under the phone frame on the
  streaming page; one gradient, the "needs you" banner's.
- A 4px grid. The page is a grid: a 212px sidebar column, then the content.
  The sidebar floats 12px from the window's top, left and bottom; the content
  has 12px padding on every side and 12px between cards. Inside a card: 14px
  sides, a 38px header row with a 1px line under it.
- Control heights: nav link 32px, button 30px (small 26px), search box 30px,
  pill 20px, badge and `kbd` 18px, table header 34px, table row 40px, list
  row 38px, log row 30px, facet row 30px.
- Icon buttons are square (30×30, small 26×26). Anything in a fixed-height
  box is centred both ways with flex, line height 1.

## Layout

Designed at 1440×900, where every page fits with no page scroll: a page is a
column of cards, and the last row takes the rest (`flex: 1`). Only lists and
feeds scroll, inside their card. Below 1440px the grids give first: six KPI
tiles become three by two, the
Overview's right column drops under the charts, and the Leases inspector
becomes a drawer strictly below 1280px (1279 is a drawer, 1280 a pane). Under
768px the sidebar is a top bar with a menu and tables stack into blocks, as
before. No page scrolls sideways at 1280×800, 1024×768, 768×1024, 390×844 or
360 wide; `e2e/console/breakpoints.spec.ts` checks every page at each.

Rules that keep text from overflowing:

- A hostname, a holder, a device or a baseline name is one line, cut with an
  ellipsis, the whole value in `title`. A **holder id** gets a middle
  ellipsis above 34 characters (`claude-code:3f2a9c…7f91c4`), since its
  tail tells sessions apart. One helper in `ui/src/model/` does it.
- A status pill never shares a line with a name that can grow: it goes
  next to the name (the list row under 1100px) or in its own State column (Fleet and
  device tables).
- Slots are a meter and the fraction (`10 / 20`) in every table and tile. Squares
  are drawn only where a caller asks for them (a worker page's Slots card) and
  only up to ten slots; 100 slots never draw 100 squares.
- A page title ellipsises; its action buttons never shrink.
- A free-text reason clamps to two lines. A long id in facts wraps.
- Counts live in one place: the page header or a group header, never on a
  filter chip or a tab.

## Components

They live in `ui/src/ds/`; a screen composes them and draws nothing of its
own that one of them draws. Named sizes and colours are above.

- **Sidebar.** A floating card: wordmark (an orange 24px rounded block with
  "S", then "Simlock" 700), a search box reading "Search" with a `⌘K` `kbd`,
  then the links (icon 16px, label 500, muted; current one `--accent-text`
  on `--nav-current`, `aria-current="page"`) in a fixed order: Overview,
  Inbox, then **Operate**: Fleet, Leases, Queue, Baselines; then
  **Observe**: Activity, Usage; then **Settings**: Settings (a gear icon), each
  group under a label. Inbox carries its
  problem count in a red round badge, none at zero. At the bottom an account
  box on `--bg`: a 26px avatar chip, the token label or id (mono, cut), the
  connection as `● connected` in `--status-ok`, and a sign-out icon; in the
  collapsed rail the connection is a 10px dot on the avatar's top-right corner
  (green, amber or red), with no row of its own. Nav links are 2px apart, in the
  rail too. The Settings link's icon is a cog with teeth.
  The desktop collapse/expand control is a quiet 30px square icon button (16px
  icon) at the foot of the sidebar, just above the account box and centred in the
  collapsed rail; the phone has no such control, its top bar is the wordmark on the
  left and the menu button on the right, 8px from the top.
- **Page header.** Title 21px with its breadcrumb in muted 500
  (`Fleet / mac-studio-01`), an optional one-line muted subtitle that holds
  figures only (`updated 18:18:04`, `49.5 GB on 4 workers`), never a
  sentence; a status pill may follow the title. Actions on the right: at most
  one primary, secondaries, then a square `⋯` menu button.
- **Card.** `--surface`, 1px border, 10px radius, clips its content. Its
  header: a label on the left, pills next, then right-aligned mono muted text
  (`peak 23 at 17:52`) and small buttons. A card that needs attention tints
  its border. A **group header** outside cards is 13px 600 text with a round
  count badge.
- **Banner.** The Overview's "N things need you": a card with a red round
  number block, a bold line, a muted line of the first issue plus "and N
  more", and one primary button ("Open Inbox"). Absent at zero.
- **KPI tile.** A label, a 28px mono number with a small muted unit after it
  ("19 / 40", "3 max 41 s"). No sparkline. A tile that leads somewhere is a
  link as a whole.
- **Pill.** 20px tall, round, 11.5px 500, a 6px dot of its colour before the
  word, tinted background. Tones: ok, warn, error, idle (grey). A `plain`
  pill has no dot and a grey fill: for figures ("now 19").
- **Agent chip.** A 26px rounded square with two mono capitals for a holder
  whose id starts with a known tool (`claude-code:`, `codex:`, `cursor:`,
  `pi:`); any other holder gets a grey chip with a dot. Never guess from a
  free-form name.
- **Button.** 30px, 8px radius, 12.5px 500, line height 1. Primary: filled
  `--accent`, dark text. Secondary: `--surface` with a `--border-strong`
  edge. Danger: `--status-error` text and a dark red edge, for Release and
  the like, never orange. Small variant 26px in cards and tiles.
- **Filter group.** A `--surface-2` track with a 1px border and 8px radius,
  2px padding; options 26px tall, the chosen one on `#2a2a30` in `--text`.
  A radio group; no counts on options.
- **Search box.** 30px, `--bg` fill, 1px border, 8px radius, a search icon
  and muted placeholder ("Filter workers").
- **Table.** Edge to edge in its card, fixed layout. Header row 34px on
  `--surface-2` with labels; rows 40px, 12.5px, a 1px line between. A name
  cell is a 26px chip or icon then a bold line and a muted second line. Mono
  for ids, hostnames, durations. The selected row is `--row-selected` with a
  2px `--accent` bar inset at its left. Group rows (`iOS · 4 baselines ·
  25.4 GB`) are 28px labels on `--surface-2`. A footer line holds the row
  count only (`1–14 of 19`). Every row ends in a `⋯` menu button. A header
  never breaks inside a word: one line, an ellipsis when it is too narrow.
  A table of one-line rows (`table-lines`: Fleet, a worker's devices and
  warm pool) also keeps each cell to one line, cut with an ellipsis and the
  whole value in `title`; its second line is muted.
- **Fleet table.** The Fleet page is one table grouped by Needs attention
  N, then Healthy N (an empty group is left out), one row per worker:
  Worker (mono name linking to the worker page, muted `macOS <v> · simlock
  <v>`), State (the pill alone; the reason, such as `905.3 GiB used of 926.4
  GiB`, shows in a popover on hover and keyboard focus of the pill), Slots
  (meter and fraction), CPU / Mem / Disk (thin meter and a mono
  figure), Leases and `⋯`, whose first entries are Undrain (confirmed) or View
  leases (a worker that is gone), then the other actions. An attention
  row is tinted `--row-warn` (`#17140c`) or `--row-error` (`#19100f`).
  Below 1100px (a phone, and the collapsed-sidebar layout) the table gives way to
  a list: a worker is a mono name and its pill, one muted line `slots n/m · CPU
  x% · Mem y% · Disk z% · N leases`, and `⋯` at the right; no labelled blocks and
  no quick-action row. Its group headers are the table's group rows: a
  `--surface-2` band in the label style, with no box or other fill around it.
- **Worker devices table.** A worker page's Devices tab is a table: Device
  (model, mono runtime beneath), State, Held by (agent chip, shortened
  holder), Expires in (clock and meter), Since (`granted 18:10`), a small
  Watch button and `⋯`. Its warm pool tab's columns have fixed widths.
- **Capabilities.** The worker page's left card lists them under their own
  label after Host: one row each, the name and a pill (`on` ok, `off` idle,
  `unavailable` warn with its reason beneath).
- **Worker table.** One `ds` component, `WorkerTable`, draws workers on the Fleet
  page and in the Overview's Fleet card: grouped rows (Needs attention, Healthy), the
  State pill with its reason on hover, a Slots meter and fraction, CPU / Mem / Disk
  meters, Leases and `⋯`; under 1100px a two-line list row. The Overview card shows
  the first eight rows of the Fleet page's grouping (a worker with an issue first); a
  longer list ends in "8 of N", the card's Open fleet button opens the rest. There is
  no tile wall and no slot legend.
- **Slots.** 12px squares, 3px apart: leased
  `--slot-leased`, ready `--status-ok`, booting `--status-idle`, quarantined
  `--status-error`, absent `--status-warn`, free a dashed `--border-strong`
  outline. The group's counts are its accessible name.
- **Meter.** A 4px track in `--track`, square ends, neutral fill, or a
  status colour by class. Never the accent. Never the only place its number
  is. Load thresholds as before (`LOAD_THRESHOLDS`).
- **Ring.** A 54px ring gauge (track `--track`, value `--slot-leased` or a
  status colour, stroke 5) with its percentage inside, for CPU, memory, disk
  and slots on a worker page and capacity by platform; a 64px one without
  text for a lease's time left. Never smaller than 46px.
- **Facts.** A two-column grid, 92px label column in muted text, 8px row gap,
  12.5px; ids in mono and allowed to wrap.
- **List row.** 38px, a 26px chip or icon, a mono name and a muted second
  line, and a right-aligned figure or a TTL (a 40px mono countdown and a
  meter). The Overview's Queue and Ending soon, the Leases summary pane, and
  the Recent events lists are this.
- **Log row.** 30px mono 12px: time (70px), an 8px status square, event
  name, subject, then the detail in muted taking the rest and cut. A warning
  or error row is tinted.
- **Feed row.** The Activity page: 38px, a 26px tinted icon box, mono event
  name, subject + detail, worker in muted mono, time at the right.
- **Facets.** The Activity page's left card: label headers, then 30px rows
  with a 14px checkbox (checked: `--accent` fill), the name and its count in
  muted mono.
- **Tabs.** Labels 18px apart over a 1px line; the current one `--text` with
  a 2px `--accent` underline. Only where two views share a card (Devices /
  Warm pool); never to duplicate a section already on the page.
- **Inspector.** The Leases page's right pane (420px): holder chip and
  wrapped mono title with a square close button, a `--surface-2` box with a
  64px ring and the 28px countdown ("of 15 min · renewed 58 s ago"), Watch /
  Copy id / Release, then facts and Recent events. With nothing selected
  the pane shows the summary: By holder bars, By platform rings, Ending in
  5 min, Longest held, and one muted line of help at its bottom.
- **Streaming page.** `/fleet/<worker>/devices/<id>`: the phone frame
  (300×650, 34px radius, 6px dark bezel) centred in a card with a radial
  glow, two overlay pills at its corners (`● LIVE · 30 fps`, `h264 ·
  720×1560 · 1.4 Mb/s`); at the right the Holder card (chip, wrapped id,
  ring + countdown, Copy lease id / Lease details / Release), Device facts,
  Recent events. The countdown is 24px mono and, as on the Leases inspector,
  reads `mm:ss` (`h:mm:ss` past an hour) from one helper. Header actions: Stop
  watching and `⋯`; no state pill by the device name (the facts show the state).
  The frame stays centred in its card whatever the state: a refusal or notice is
  drawn inside the phone's screen, centred, wrapping and muted, as the daemon's
  sentence without its transport prefix (`The daemon answered 404 ...`). View only. The device drawer has no Screen tab; an old
  `?drawer=screen` link redirects here.
- **Chart.** Recharts. Line and area in `--accent` with a 9% fill, bars in
  `--slot-leased` at 55% with the current bucket in `--accent`, grid lines
  `--border`, axis labels 10px mono muted. Height fixed by its card. No
  animation. Titles, a text line of the numbers and a screen-reader table
  as before.
- **Drawer, menu, dialog, toast, search dialog, pager, scroll box.** Keep
  their behaviour (focus, keyboard, announcements, limits); restyle to the
  tokens above: 10px radius on floating surfaces, 8px on entries, menu
  entries 36px, dangerous entries last in `--status-error`.

## Focus, keyboard, motion, voice

Unchanged: everything clickable is a real element; the focus ring is a 2px
`--accent-text` outline 2px off, `:focus-visible` only; "Skip to content"
first; ⌘K opens search. Motion is 120ms for colour, 220ms for moves, once,
none under `prefers-reduced-motion`; charts never animate. Voice: short plain
sentences, the CLI's names, verbs on buttons, no exclamation marks, no
subtitles that explain, no key-hint decoration, an empty page says so in one
line.


## Settings page

`/settings`, last in the sidebar under its own **Settings** group. Two
cards under a title with no actions or subtitle:

- **Console**: each preference is a label and a filter group (theme System,
  Light, Dark; sidebar Expanded, Collapsed; default range 1 h, 6 h, 24 h,
  7 d; rows per page 25, 50, 100; holder ids Short, Full). They live in the
  browser's `localStorage`, apply at once, and the sidebar choice is the
  same stored choice as the sidebar's own toggle. The theme sets
  `data-theme` on `<html>`, which `foundation.css` honours beside the
  system preference. A default range and rows per page only fill in what
  the URL leaves out.
- **Daemon**: read-only. The daemon's live `config.get` answer (`GET
  /v1/config`, admin), grouped by top-level section, each key as Facts with
  the key path and the value in mono and a small Copy button for
  `simlock config set <key> <value>`; a masked secret has no button. A token
  that may not read it gets one muted line. A gateway shows its own config,
  not its workers'.

## Sidebar and contrast reference amendments

The desktop collapse/expand button, at the sidebar's foot above the account,
preserves the existing action and is an addition to the render.
Stage 0 and stage 7 paired images must show this exception. Where a reference
foreground or essential stroke fails WCAG AA, change only that colour, keeping
the reference geometry, typography and fills. Record the selector, colours,
ratios and paired images; this does not exempt other visual differences.

For `.nav-group-label` on `--surface` (`#141416`), the reference's `#6f6f79`
is 3.702:1; `--text-muted` (`#8e8e97`) is 5.665:1. Both-theme axe must
evaluate `color-contrast`, not suppress it. The original renders stay intact.

Agent chips, pills and buttons keep 4.5:1 or more in both themes; the
chips' text is darker on its light tint and lighter on its dark tint than the
reference, and `ui/src/ds/contrast.test.ts` computes every pair from the tokens.
(decided in delivery, pending the maintainer)

## Fleet reference amendment

The Fleet page is a grouped table, not the reference's cards and tiles (see
Fleet table above); the Worker page's devices are a table too.

The reference's **Add worker** is a link to the existing
[joining instructions](https://callstackincubator.github.io/simlock/docs/gateway/joining-workers).
**Release leases** becomes an equally styled **View leases** link to `/leases`.
Neither sends a write. Keep reference placement and geometry; stage-2 and
stage-7 paired images record these exceptions. Test both links in the worker
browser spec. (decided in delivery, pending the maintainer)

## Baselines reference amendment

Use All / Stale / Ready and an equally styled **Prepare baseline** link to
[baseline preparation instructions](https://callstackincubator.github.io/simlock/docs/worker/baselines)
in place of the reference's Building filter and Build baseline action.
Only ready/stale list data is supported (`src/contract/device-schemas.ts:119-135`);
the harness replaces the fictitious building row with a ready row as a DATA
difference, preserving row/pill geometry. The existing save operation ends a
held lease (`src/http/admin-declarations.ts:158-174`); this presentation adds
no save workflow or progress field. Keep original render files unchanged.
The stage-5 PR records the DATA substitution and filter/link amendment with
paired images; every other reference geometry requirement still applies.
`ui/src/screens/baselines/baselines.dom.test.tsx` covers All/Stale/Ready,
search/paging (`:143`) and the preparation link without a save request
(`:185`); the render harness covers ready/stale rows. (decided in delivery, pending the maintainer)
