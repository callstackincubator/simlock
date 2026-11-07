# Console redesign: the plan

Rebuild the console to the look in [DESIGN.md](../DESIGN.md). The reference
is the renders here, not the words: an agent compares its page with its
render and stops only when the two differ in data alone.

| Render                                                   | Page                                  |
| -------------------------------------------------------- | ------------------------------------- |
| [renders/1-overview.png](renders/1-overview.png)         | Overview                              |
| [renders/2-fleet.png](renders/2-fleet.png)               | Fleet                                 |
| [renders/3-worker.png](renders/3-worker.png)             | A worker's page                       |
| [renders/4-streaming.png](renders/4-streaming.png)       | A device's streaming page (new route) |
| [renders/5-leases-empty.png](renders/5-leases-empty.png) | Leases, nothing selected              |
| [renders/6-leases-selected.png](renders/6-leases-selected.png) | Leases, one selected            |
| [renders/7-baselines.png](renders/7-baselines.png)       | Baselines                             |
| [renders/8-activity.png](renders/8-activity.png)         | Activity                              |
| [renders/mosaic.png](renders/mosaic.png)                 | All eight on one sheet                |

The renders come from [prototype/](prototype/): `node
docs/internal/console-redesign/prototype/build.mjs` from the repo root
redraws them into `prototype/screens/` (fonts from `node_modules`, Chromium
from `@playwright/test`). `d.mjs` holds every CSS value the renders use; when
DESIGN.md is unclear, read the prototype's CSS. The prototype is mock HTML,
not component code: copy its values, not its markup.

Pages without a render (Inbox, Queue, Usage, sign-in, not found) keep their
structure and take the new components. Dark is the designed theme; the light
theme takes the same structure with values the implementer derives, and the
maintainer accepts or adjusts them from a screenshot.

## How an agent verifies a stage

1. Build the console and run the render harness (stage 0 adds it):
   `pnpm test:console --project=chromium e2e/console/renders.spec.ts`. It
   signs in against the stubbed daemon, sets the window to 1440×900, opens
   each page with the fixture data, and writes `current/<page>.png` beside
   this file.
2. Open `current/<page>.png` and `renders/<n>-<page>.png` side by side and
   list every difference that is not data: a missing element, a wrong
   size, radius, colour, weight, spacing, alignment, a line that wraps or
   is cut where the render's is not. Fix, rerun, repeat. The fixture data
   differs from the mock data; shape, colour and size do not.
3. Check the same page at 1280×800 and 390×844: no sideways page scroll, no
   element outside its card, no text over another.
4. Run the console lane in Chromium for the specs the diff touches and axe
   in both themes (the lane does this).
5. The PR body carries both images for each page the stage touched, and a
   list of what still differs and why.

A stage is done when its pages match their renders, its tests pass, and the
website page [console.mdx](../../../website/src/content/docs/docs/worker/console.mdx)
describes what the page now shows (documentation rule 9).

## Stages

Stage 0 blocks the rest. Stages 1–6 run in parallel, each on its own
branch from stage 0's merge, each one GPT 6.1 Sol agent. Stage 7 runs last.

### 0. Foundation and harness

One agent; everything else waits for it.

- `ui/src/ds/foundation.css`: the tokens, scale, radii and control heights
  of DESIGN.md. Rename or add tokens; delete `--chip` and `--field` (an
  input's fill is `--bg`).
- Restyle the `ds` primitives every page shares, to the renders' sidebar,
  page header and cards: `sidebar` (floating card, search box, group
  labels, account box, red Inbox badge), the page header (title with
  breadcrumb, subtitle for figures, actions), `panel` (card with the 38px
  header), `button` (30/26px, primary/secondary/danger/icon), `choice`
  (filter group), `search-field`, `table` (34px header on `--surface-2`,
  40px rows, selected row bar, group rows, footer with the count only),
  `facts`, `stat` (KPI tile, no sparkline), `status` (pill, dot), `meter`,
  `slots` (cap at ten), `menu`, `drawer`, `confirm-dialog`, `toast`,
  `command-palette` (radii and tokens only).
- New primitives: `pill`, `chip` (agent chip with the known-prefix rule),
  `ring`, `log-row`, `list-row`, `feed-row`, `group-header`, `banner`.
- `ui/src/model/holder.ts`: `shortHolder(id)` middle ellipsis above 34
  characters, and `agentKind(id)` for the chip; unit tests for ids of every
  form in `src/agent-identity/` (tool-prefixed session ids, token labels,
  `mcp:<pid>`, 256-character free-form).
- The render harness `e2e/console/renders.spec.ts` with fixture data close
  to the mock data's shape: 8 workers (one with 20 slots, one with a
  `.local` hostname, one disconnected, one drained, one at 91% disk), 14
  leases with holders of every form, 9 baselines (one stale, one building),
  an hour of events. Screenshots to `docs/internal/console-redesign/current/`
  (gitignored).
- Verify: the shell (sidebar, header, one card) against the top-left of
  `1-overview.png`; every existing page still renders with the new
  primitives, even if its layout is still the old one.

### 1. Overview — `1-overview.png`

Banner (count, first issue, "and N more", Open Inbox), six KPI tiles, the
worker wall (4 columns, 1px gaps, pill under the name, capped slots, three
meters), Leases held area chart, Capacity rings, Queue and Ending soon lists,
Requests waiting bars. Range filter in the header. Subtitle is
`updated <time>` only.

### 2. Fleet and the worker page — `2-fleet.png`, `3-worker.png`

Fleet: All / Issues / Busy filter and a search box, "Needs attention N"
attention cards (two-line reason, labelled slot rows, meters, actions, lease
count), "Healthy N" compact tiles with the `leased / slots` fraction, Worker
events log full width. No Groups/Table toggle: the table view goes.

Worker page: breadcrumb title with the state pill, Drain and `⋯`; four ring
gauge cards; a left card with Slots, Host facts (worker id wraps), Baselines
here; a right card with Devices / Warm pool tabs, device tiles (name, then
runtime + pill, holder chip, TTL, Watch button and `granted` / `booted`
time), and the Events on this worker log. No Events tab.

### 3. Leases — `5-leases-empty.png`, `6-leases-selected.png`

Filter group and search box; a table of Held by / Device / Worker / Expires
in (no Granted column) with the footer count only; a stable 420px right pane:
the summary (By holder, By platform, Ending in 5 min, Longest held, a help
line) when nothing is selected, the inspector (chip, wrapped title, ring and
countdown, Watch / Copy id / Release, facts, Recent events; no tabs) when a
row is. Selecting a row never reflows the table. Below 1280px the inspector
is a drawer. The lease drawer's Screen tab goes; Watch opens the streaming
page.

### 4. Streaming page — `4-streaming.png`

A new route `/fleet/<worker>/devices/<device>` reusing
`ui/src/screens/fleet/screen-panel.tsx` and `ui/src/state/screen.ts`: the
phone frame centred in a card with the two overlay pills, Holder card
(wrapped id, ring and countdown, Copy lease id / Lease details / Release),
Device facts, Recent events; header: breadcrumb, `streaming` pill, Stop
watching, `⋯`. One stream per open page, closed with it. The device drawer's
Screen tab becomes a Watch button to this page. View only; the input socket
stays unused.

### 5. Baselines — `7-baselines.png`

Filter group and search; a grouped table (iOS, Android group rows with count
and size) of Baseline (name, model · runtime), Size as text, Worker, Built,
State (pill, and a stale reason as a muted second line), `⋯`; under it one
"Disk used by baselines" card, two columns of worker meters relative to each
disk. No builds chart, no "runtimes without a baseline".

### 6. Activity and the pages without a render — `8-activity.png`

Activity: a 230px facets card (Kind, State, Worker with counts) and the feed
card with the Events per minute bars at its top and feed rows under; the
search box and range filter in the header. Then re-skin Inbox, Queue, Usage,
sign-in and not found with the stage-0 primitives, keeping their structure;
screenshot each at 1440×900 for the PR so the maintainer can judge them
without a render.

### 7. Breakpoints, themes, docs

After 1–6 merge, one agent: the breakpoints DESIGN.md names (1280, 768,
390), the light theme values with a screenshot of every page in both themes,
the axe pass, `DESIGN.md` corrected wherever a merged page settled a detail
the guide got wrong, the website's console page and its screenshots, and the
removal of anything in `ui/src/ds/` no page uses (fallow finds it).

## Decisions for the maintainer

- **Light theme:** derived values accepted from screenshots (the plan), or
  dark only until a light render exists.
- **Leases inspector under 1280px:** a drawer (the plan), or the pane stays
  and the table narrows.
- **Streaming page input:** view only (the plan); driving the device from
  the console is a product decision with its own ADR.

## Delivery execution record

Feature: [#1425](https://github.com/callstackincubator/simlock/issues/1425).
The feature body and its subissues hold the technical specs, ownership,
source gaps and overlap findings. They remain draft pending independent spec
checking; this record grants no issue claim or implementation permission.

| Stage | Task | Depends on |
| --- | --- | --- |
| 0. Foundation and render harness | [#1426](https://github.com/callstackincubator/simlock/issues/1426) | — |
| 1. Overview | [#1427](https://github.com/callstackincubator/simlock/issues/1427) | stage 0 |
| 2. Fleet and worker page | [#1428](https://github.com/callstackincubator/simlock/issues/1428) | stage 0 |
| 3. Leases table, summary and inspector | [#1429](https://github.com/callstackincubator/simlock/issues/1429) | stage 0 |
| 4. Device streaming page and Watch links | [#1430](https://github.com/callstackincubator/simlock/issues/1430) | stage 0 |
| 5. Baselines grouped table and disk usage | [#1431](https://github.com/callstackincubator/simlock/issues/1431) | stage 0 |
| 6. Activity and pages without renders | [#1432](https://github.com/callstackincubator/simlock/issues/1432) | stage 0 |
| 7. Breakpoints, themes and final docs | [#1434](https://github.com/callstackincubator/simlock/issues/1434) | stages 1–6 |

Stage 0's reviewed branch and pinned head are the parallel pages' baseline.
The stages' “merge” above means merge-forward integration into the retained
feature stack, not an early merge to `main`: stages 1–6 start after foundation
review, stage 7 after their reviews and integration. Delivery rule 15 keeps
all PRs open and merges the complete stack together. The orchestrator orders
parallel branches into that stack as reviews pass. All delivery agents use
GPT 6.1 Sol as the maintainer requested.
