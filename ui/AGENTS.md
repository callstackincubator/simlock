# Web console

Does: the operator's web console — a React page the daemon serves from `dist/ui`.
Entry: `src/main.tsx` → `App` (`src/app/app.tsx`).
Uses: the daemon's `/v1` HTTP API and event stream; contract types from `src/contract/` (type-only), and two files as values, each imported by its own path (the index would pull the schemas, and zod's `eval`, into the bundle): `version-order.ts`'s `isNewerVersion` and `inbox.ts`'s helpers (`holderOf`, `isExpiring`, `problemCount`, ...), which the daemon's Inbox rules share. Both `past-index` exemptions in `.dependency-cruiser.mjs` are maintainer-authorized (#825 Decisions, ADR 0044 §3).
Surface: [console.mdx](../website/src/content/docs/docs/worker/console.mdx). Look and voice: [DESIGN.md](../docs/internal/DESIGN.md).

## Layers

Each layer imports only the layers below it. `.dependency-cruiser.mjs` enforces it (rules
`ui-*`); `src/lint-rules.test.ts` proves each rule fires.

| Layer          | Holds                                                                     | May import                  |
| -------------- | ------------------------------------------------------------------------- | --------------------------- |
| `src/app/`     | `App`, the `Shell`, the route table (`routes.ts`)                         | every layer                 |
| `src/screens/` | one folder per page: presentation only                                    | `ds`, `state`               |
| `src/state/`   | React hooks that read `data`, apply `model`, return view models           | `data`, `model`, `ds` types |
| `src/ds/`      | the design system: tokens, components, their CSS                          | nothing of the console      |
| `src/data/`    | the API client, session, preferences, live connection, SSE, screen stream | `model`                     |
| `src/model/`   | business rules: pure functions over the daemon's data                     | nothing; contract types     |

- A screen never fetches, never reads a route, never decides what a state means. It gets a view
  model from a `state/` hook (`useOverview`) and draws it with `ds/` components.
- `model/` has no React and no network, so every rule is a plain unit test.
- `ds/` knows nothing of Simlock's data: props are plain values (`tone`, `percent`, `to`).
  `Link` navigates through `NavigationProvider`, which `App` feeds with `state/router.ts`.

## How a screen is built

1. Model: a pure builder in `src/model/<page>.ts` turns route data into the page's view model
   (`overviewOf` in `overview.ts`). Shared rules live once: `workerHealth`, `workerSlots`
   (`fleet.ts`), `eventSummary`, `eventTone` (`activity.ts`), `inboxTone`
   (`inbox.ts`), the word → tone tables (`tones.ts`), page paths (`paths.ts`).
2. State: a hook in `src/state/<page>.ts` reads routes with `useRouteQuery`, turns each into a
   `LoadView` (`resource.ts`: `loadView`, `mapView`, `bothViews`), and maps it through the
   builder. It re-exports the view-model types the screen needs.
3. Screen: `src/screens/<page>/index.tsx` exports `<Page>Screen`, wraps content in `Loaded`, and
   composes `ds` components. Its CSS sits beside it.
4. Route: an entry in `src/app/routes.ts` gives it a path, a label and an icon.

## Session

`data/session.ts` holds who is signed in: a token (kept in `sessionStorage`), a person a sign-in
proxy signed in (memory only), none, checking (the first `GET /v1/identity` runs), or ended. The
API client reports a 401, or an answer that is not Simlock's, to the session; in a proxy session
that starts the one shared `data/identity-check.ts`, in a token session a 401 forgets the token and
asks it. The live connection asks `session.lost()` when it loses the stream, in a proxy session
the same check: reconnect at once, back off as for an unreachable daemon, or stop while the session
ends. `model/proxy-refusal.ts` words a refusal.

`data/mode.ts` keeps the daemon's mode, `daemon.version` and `daemon.latestVersion` (the fields of
`GET /v1/status` the console reads) once the live connection starts and again after each reconnect; a
read that fails leaves none. The same read repeats every 10 minutes (the daily check emits no event);
a failed repeat keeps the last values, and the timer stops with the live connection. `useDaemonMode`
and `useDaemonFacts` (`state/live.tsx`) give them to state and to the sidebar's update notice
(ADR 0037 §4, ADR 0042).

## Reads

The Inbox is the daemon's: `GET /v1/inbox` (`inbox.get`, rules in `src/contract/inbox.ts`) answers the items, and `['inbox']` is the only key the sidebar's count reads, on every page. The Inbox page and the Overview's Needs you read it and `['workers']` (for names, links and lease counts); a read that fails shows the page's refusal. `model/inbox.ts` only draws rows, tones, filters and the drawer from the items, counting a wait or the time left from the item's own timestamp against the daemon's clock. Events that mark workers, leases or requests stale mark `['inbox']` too.

A page reads a route only while it is on screen (`useRouteQuery`, `state/live.tsx`). `state/queries.ts`
holds the TanStack `QueryClient` (the dependency rules keep it out of `data/` and `model/`) and the keys and times of ADR 0044:
`['workers']` every 15 s, `['leases']`, `['lease', id]` and `['inbox']` 10 s, `['lease-requests']` 5 s,
`['stats', range]` 60 s, `['tokens']` never; a read stays fresh 2 s (stats 30 s, tokens 5 min);
data no page uses is dropped after 60 s. A key polls only while a page uses it, the tab is shown and
the connection is up; a hidden tab or a lost connection reads nothing, and coming back reads each key
on screen once. An event marks keys stale through `model/stale-keys.ts`, and the burst window reads
them once, 300 ms after the last event of a burst (at most 1 s after its first), and again 1.5 s later;
a key no page shows is only marked. `LiveConnection` (`data/live/connection.ts`) keeps the stream, the
phase, the health checks and the clock offset, and does one classified GET for a read
(`connection.read`): a refusal is the route's own answer, a timeout while the daemon starts is asked
again, any other failure is the connection lost (`ConnectionLost`), which a page never shows as an
error. A refused stream is asked for again a second later.

A read sends back the ETag of the route's last answer (`ApiClient.get(path, { tag })`, kept per key in
`state/queries.ts`); a `304` keeps the cached data object, so nothing re-renders, and one that finds
its data dropped is read again without a tag. A `lease.renewed` event moves the lease's `ttlDeadline`,
`lastRenewedAt` and `ttlMs` in `['leases']` and `['workers']` in place (`model/renewal.ts`) with no read,
and the deadline is kept for 60 s against an older answer. Console browser stubs fetch through
`e2e/console/full-fetch.ts`, which drops `If-None-Match`.

## Actions

An action is described once per kind of item in `model/actions.ts` (`leaseActions`, `requestActions`,
`workerActions`, `inboxActions`): its label, danger, confirm, toasts and request (ADR 0037 §3). A
screen never builds one; `state/actions.ts` (`useActions`) turns them into menu entries and its `run`
is the one runner: it asks `confirm`, calls `ApiClient.write` and tells `notify` the outcome, and keeps
an in-flight flag per item key, shared by the row, the drawer and the Inbox so a second click sends
nothing. `notify` and `confirm` are plain functions `App` passes in through `state/services.tsx`.
`write` sends through the same path as a read (token, `credentials`, the 401 path), but a network
error or a timeout on a write throws without asking whether the session ended. The worker actions
are offered only when `useDaemonMode` says `gateway` (ADR 0037 §4).

## Search

⌘K / Ctrl+K (`app/shell.tsx`, ignored while a modal drawer or dialog is open) or the sidebar's "Search or
jump to…" opens `CommandPalette` (`ds/command-palette.tsx`). `model/search.ts` builds the results from
the same views the pages show (pages, workers, their devices, `leaseRows`, `waitingTable`) and the
actions of `model/actions.ts`, filters them by word prefix and orders them; `state/search.ts` keeps
each read as it stood the first time it settled (`useSettledOnce`), so the list is built when the
dialog opens, a group fills in once and then never changes, and runs a result through `navigate` or
`useActions().run`. The palette keeps its highlight by result id, which Base UI's Autocomplete does
not (its highlight is an index it resets when the items change), so the listbox is written in `ds/`.

## Pages

| Path                         | Screen   | Layout                                                                                                                                         |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                          | Overview | range chips in the toolbar, five stat tiles, Needs you, capacity, two charts, workers table                                                    |
| `/fleet[/<id>[/<deviceId>]]` | Fleet    | table; a worker opens as its own page (load, capacity, leases, tabs Devices, Warm pool, Host, Events in `?tab=`); a device opens in a `Drawer` |
| `/leases[/<id>]`             | Leases   | toolbar (filters, search) + table; the lease opens in a `Drawer` (Details, Screen, Events)                                                     |
| `/queue[/<id>]`              | Queue    | Wait p95 tile + table; a request opens in a `Drawer`                                                                                           |
| `/inbox[/<key>]`             | Inbox    | toolbar (group chips) + a panel per group; an item opens in a `Drawer` (what happened, facts, events)                                          |
| `/activity[/<id>]`           | Activity | chart, toolbar (type chips, search) + event feed that scrolls back through the history; an event opens in a `Drawer` with the payload          |
| `/usage`                     | Usage    | range chips in the toolbar, stat tiles, the Device slots in use chart, panels of tables (workers, requesters page in the URL)                  |

The sidebar groups the pages: Overview and Inbox, then Operate (Fleet, Leases, Queue), then
Observe (Activity, Usage); a route's `group` in `routes.ts` puts it in one.

Leases, Queue, Inbox and Activity show the list alone, and the chosen item opens in a drawer over it
(`state/drawer.ts`: closing steps back when the drawer was opened from the list).

Activity's `EventFeed` (`data/event-feed.ts`) holds the events: the stream, the last hour and the gap after a reconnect add
newer ones, and `loadOlder` adds the 100 before the oldest held (`GET /v1/events?before=&limit=100`, or `?limit=100` with
none held). It reports how the history stands (`HistoryState`: more, start, gone, failed); `ds/feed.tsx` calls `onNearEnd`
within 20 rows of the end and draws the end row.
Lists page in the URL (`state/paging.ts`, `model/paging.ts`).

## Design system

`src/ds/index.ts` exports every component. Tokens and base elements: `foundation.css`.

- Frame: `AppFrame`, `Sidebar` (collapsible; width kept per browser by `data/preferences.ts`),
  `Page`, `ListRow`, `Drawer`, `DrawerTabs`
  (a modal panel over the page, closed by an `IconButton` from `button.tsx`; Base UI), `Toolbar` (filters left, search right), `DesignProvider`
  (Base UI's `CSPProvider`, so no `<style>` element).
- Content: `Panel`, `Card`, `Row`, `Grid`, `StatRow`, `StatTile`, `Facts`, `DataTable`, `Pager`,
  `MinuteChart`, `MinuteTable`, `Empty`, `Id`, `Loaded`.
- Signals: `Status` (square and word), `StatusDot` (square alone, the word as its name),
  `Meter`, `Slots`, `ShareBar`, `SlotLegend`.
- Controls: `Button`, `ButtonLink`, `Link`, `ChoiceChips` (a radio group), `Tabs`, `SearchField`, `Icon`.
- Search: `CommandPalette` (Base UI Dialog around a combobox and listbox, written in `ds/`).
- Actions: `RowMenu` (a ⋯ button and its menu), `MenuRow` (a table row that opens the same menu on a
  right-click), `ActionBar` (a drawer's or page's first safe action and its ⋯; Base UI Menu and
  ContextMenu), `createConfirmer` and `ConfirmHost` (Base UI AlertDialog, type-to-confirm, one host), `createToaster`
  and `ToastHost` (Base UI Toast: its manager is the only queue, and owns the timer, the limit and
  closing). `DataTable` takes a `menu` for its last column.

## Rules

- Colour is never the only signal: a `StatusDot` and a `Slots` group carry their words as
  accessible names; a `Meter` and a `ShareBar` only shade a figure printed beside them.
- Orange is brand and interaction only: never a state.
- Nothing sets a `<style>` element (CSP `style-src 'self'`); a level arrives as a CSS custom
  property through React's `style` prop, as `Meter` does.
- Motion stays under 0.3 s, never loops, and stops under `prefers-reduced-motion`.
- Every page works at 360px wide with no sideways page scroll.
- Unit tests run in Node with no DOM: test `model/` and `data/` directly, and a screen or a
  `ds` component with `renderToStaticMarkup`. The browser lane (`e2e/console/`) covers the rest.

## Known gaps

- **The Events chart counts from the events held.** It reaches back one hour only; the Overview's
  figures come from `GET /v1/stats` for the range in `?range=`.
