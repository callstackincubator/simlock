# Web console

Does: the operator's web console — a React page the daemon serves from `dist/ui`.
Entry: `src/main.tsx` → `App` (`src/app/app.tsx`).
Uses: the daemon's `/v1` HTTP API and event stream; contract types from `src/contract/` (type-only).
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
2. State: a hook in `src/state/<page>.ts` reads routes with `useLiveResource`, turns each into a
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

`data/mode.ts` keeps the daemon's mode (`daemon.mode` of `GET /v1/status`, the one field the console
reads from that route) once the live connection starts and again after each reconnect; a read that
fails leaves none. `useDaemonMode` (`state/live.tsx`) gives it to state (ADR 0037 §4).

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
