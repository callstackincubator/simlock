# Web console

Does: the operator's web console — a React page the daemon serves from `dist/ui`.
Surface: [console.mdx](../website/src/content/docs/docs/worker/console.mdx). Look and voice: [DESIGN.md](../docs/internal/DESIGN.md).

Paths below start at `ui/`.

## Rules

Layers:

- `src/app/` may import every layer. A screen (`src/screens/`) imports only `ds` and `state`. `src/state/` imports `data`, `model` and the types of `ds`. `src/data/` imports `model`. `src/model/` imports nothing of the console, and neither does `src/ds/`. The `ui-*` rules in `.dependency-cruiser.mjs` enforce it, and the repo root's `src/lint-rules.test.ts` proves each rule fires.
- A screen never fetches, never reads a route, never decides what a state means. It gets a view model from a `src/state/` hook and draws it with `src/ds/` components.
- `src/model/` has no React and no network, so every rule is a plain unit test. A rule two pages share lives there once.
- `src/ds/` knows nothing of Simlock's data: its props are plain values. `Link` navigates through `NavigationProvider`, which `App` feeds.
- The contract is imported for types only. Its `src/contract/version-order.ts` and `src/contract/inbox.ts` (at the repo root) are the two files imported as values, each by its own path: the index would pull zod's `eval` into the bundle and break the page's Content-Security-Policy. Both exemptions in `.dependency-cruiser.mjs` are maintainer-authorized (#825 Decisions, ADR 0044 §3).

Session:

- `src/data/session.ts` holds who is signed in. A token is kept in `sessionStorage`; a person a sign-in proxy signed in is kept in memory only.
- The API client reports a 401, or an answer that is not Simlock's, to the session. In a proxy session that starts the one shared check in `src/data/identity-check.ts`; in a token session a 401 forgets the token and asks for it.
- The live connection asks `session.lost()` when it loses the stream. In a proxy session that is the same check, and its answer is to reconnect at once, back off as for an unreachable daemon, or stop while the session ends.
- `src/data/mode.ts` reads the daemon's mode and versions once the live connection starts and again after each reconnect. It repeats the read on a timer (`RE_READ_MS`) because the daily update check emits no event. A failed repeat keeps the last values, and the timer stops with the live connection.
- The worker actions are offered only when `useDaemonMode` says `gateway`; while the mode is unknown the console never guesses it.

Reads:

- A page reads a route only while it is on screen (`useRouteQuery`, `src/state/live.tsx`). The keys and times of ADR 0044 are in `src/state/queries.ts` and nowhere else.
- A key polls only while a page uses it, the tab is shown and the connection is up. A hidden tab or a lost connection reads nothing, and coming back reads each key on screen once.
- An event marks keys stale through `src/model/stale-keys.ts`, and a burst of events is read once after it goes quiet, then once more. A key no page shows is only marked.
- `connection.read` (`src/data/live/connection.ts`) classifies every read: a refusal is the route's own answer, a timeout while the daemon starts is asked again, and any other failure is the connection lost (`ConnectionLost`), which a page never shows as an error.
- A read sends back the ETag of the route's last answer. A `304` keeps the cached data object, so nothing re-renders; one that finds its data dropped is read again without a tag.
- A `lease.renewed` event moves the lease's deadline in `['leases']` and `['workers']` in place (`src/model/renewal.ts`) with no read of those lists, and the moved deadline is kept for a while (`RENEWAL_KEPT_MS`) against an older answer.
- The Inbox is the daemon's: `GET /v1/inbox` answers the items, by the rules in the repo root's `src/contract/inbox.ts`. `['inbox']` is the only key the sidebar's count reads, and events that mark workers, leases or requests stale mark it too. `src/model/inbox.ts` only draws the items.
- The Inbox drawer and the lease drawer share one list of recent events per tab (`src/data/recent-feed.ts`, held by `LiveProvider`); it is dropped a while after its last user closes (ADR 0044 §1).

Actions and search:

- An action is described once per kind of item in `src/model/actions.ts` (ADR 0037 §3). A screen never builds one.
- `useActions().run` (`src/state/actions.ts`) is the one runner: it confirms, writes and notifies, and keeps an in-flight flag per item key, shared by the row, the drawer, the Inbox and the search, so a second click sends nothing.
- A write goes through the same path as a read, but a network error or a timeout on a write throws without asking whether the session ended.
- The search keeps each read as it stood the first time it settled, so a group fills in once and then never changes while the dialog is open.
- The palette keeps its highlight by result id. Base UI's Autocomplete keeps an index it resets when the items change, so the listbox is written in `src/ds/`; do not swap it back.
- Base UI's toast manager is the only toast queue: it owns the timer, the limit and closing.

Look:

- The renders in `docs/internal/console-redesign/renders/` are the reference and `docs/internal/DESIGN.md` the words; a screen that differs from its render is wrong until the render is changed.
- Colour is never the only signal: a status is a pill with the daemon's word, a `Slots` group carries its counts as its accessible name, a `Meter` or a ring only shades a figure printed beside it.
- Orange is brand and interaction only: never a state. Danger is `--status-error`.
- Text that can grow (hostname, holder, device, baseline) is cut on one line with the whole value in `title`; a holder id is shortened in the middle by one helper in `src/model/` and nowhere else. A status pill never shares a line with such text.
- Counts live in the page header or a group header, never on a filter or a tab. A tab never duplicates a section already on the page.
- Nothing sets a `<style>` element (CSP `style-src 'self'`); a level arrives as a CSS custom property through React's `style` prop, as `Meter` does.
- Motion is short, never loops, and stops under `prefers-reduced-motion`. Every page works at the narrowest phone width with no sideways page scroll. DESIGN.md holds both figures.

Tests:

- Unit tests run in Node with no DOM: test `src/model/` and `src/data/` directly, and a screen or a `ds` component with `renderToStaticMarkup`. The browser lane (`e2e/console/` at the repo root) covers the rest.
- Console browser stubs fetch through the repo root's `e2e/console/full-fetch.ts`, which drops `If-None-Match`: a stub that edits the daemon's answer would otherwise be handed a `304` with no body to edit.

## Adding a page

1. Model: a pure builder in `src/model/` turns route data into the page's view model.
2. State: a hook in `src/state/` reads routes with `useRouteQuery`, turns each into a `LoadView` (`src/state/resource.ts`) and maps it through the builder. It re-exports the view-model types the screen needs, since a screen may not import `src/model/`.
3. Screen: a folder in `src/screens/` exports the screen, wraps its content in `Loaded` and composes `ds` components.
4. Route: an entry in `src/app/routes.ts`; its `group` puts it in a sidebar group.

## Known gaps

- **The Events chart counts from the events held.** It reaches back one hour only; the Overview's figures come from `GET /v1/stats` for the range in `?range=`.
