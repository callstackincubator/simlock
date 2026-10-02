# 0011. The console is a built app the daemon serves at `/`

- **Status:** Accepted — not yet implemented
- **Date:** 2026-10-02
- **Issue:** [#88](https://github.com/callstackincubator/simlock/issues/88)
- **Supersedes:** nothing.
- **Depends on:** [ADR 0003](0003-one-typed-daemon-contract-behind-every-frontend.md)
  for the contract and the roles, [ADR 0005](0005-gateway-and-worker-modes.md)
  for the fleet routes, and [ADR
  0012](0012-a-worker-answers-the-fleet-operations-as-a-fleet-of-one.md) for
  the sign-in check in §5.

## Context

#88 asks for a web console that operators open in a browser. The daemon
serves it, nothing is fetched from the internet, and only an operator token
signs in. The console must look the same on a gateway and on a single host.

Three choices shape every task that builds it: what the console is made
with, how it reaches the browser, and how it holds the token. Each is
expensive to change once views are built on top of it.

## Decision

### 1. Source and toolchain

The console is a React app in TypeScript, built with Vite. Its source lives
in `ui/` at the repository root, beside `src/`.

- `ui/` has its own `tsconfig.json`, with the DOM library and JSX.
- The console uses the contract's types, imported type-only from
  `src/contract`. No daemon code is bundled into it.
- `lint`, `typecheck` and `format` cover `ui/` as well as `src/`.
- React, Vite and every other console library are dev dependencies. The
  published package gains files, not runtime dependencies.
- Vite's `build.assetsInlineLimit` is `0`, so no font or image is inlined as
  a `data:` URI.

### 2. Build

`pnpm build` runs two scripts in order: `build:daemon`, the TypeScript build
that `build` is today, then `build:ui`, which runs `vite build` into
`dist/ui`. The package already publishes `dist`, so `dist/ui` ships with it.
Scripts that run `pnpm build` today keep doing so.

Vite writes the built JavaScript, CSS and fonts under `dist/ui/assets/`, each
name carrying a content hash.

### 3. Serving

Serving files is impure, so it lives in `src/http/server.ts`, the one file
in `src/http` allowed to import `@hono/node-server`. It wraps `app.fetch`.
`app.ts` stays a pure request-to-response function.

For each request:

1. A path that is `/v1` or starts with `/v1/` goes to the app, unchanged.
   The page fallback never applies there. An unknown `/v1` path keeps
   today's answer.
2. A `GET` or `HEAD` for a file in `dist/ui` serves that file, with
   `serveStatic` from `@hono/node-server/serve-static`. The root is found
   from the module's own URL, never from the working directory.
3. A `GET` or `HEAD` for a path with no file extension serves
   `dist/ui/index.html`, so a page URL survives a reload.
4. Anything else is `404`. A missing asset is never answered with the page.

The console is served whenever HTTP is enabled, in both modes. There is no
config key for it.

Console files need no token. They hold no data. Data comes only from `/v1`,
which keeps its own auth.

Console requests are not written to the request log. Like `/v1/healthz`,
they are anonymous, and logging them would let anyone drive the log.

When `dist/ui/index.html` is missing, as after a TypeScript-only build, the
daemon logs one warning at start. Console paths then answer `404`.

### 4. Caching and headers

These headers are set on the finished response, after the file is read.
`serveStatic`'s `onFound` hook is not used for them.

- Files under `/assets/`: `Cache-Control: public, max-age=31536000,
  immutable`.
- Every other console file, `index.html` included:
  `Cache-Control: no-cache`, so a new release shows on the next load.

Every console response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self'; font-src 'self';
  connect-src 'self'; manifest-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

No inline script and no `<style>` element, including any a library would
inject at runtime. React's `style` prop is allowed: it does not create one.

### 5. Nothing from the internet

Fonts, icons and scripts are bundled. The fonts are Geist and Geist Mono
(OFL-1.1). `connect-src 'self'` makes the browser refuse any request to
another host, so this holds even if a dependency tries.

### 6. Sign-in

The operator pastes a token. The console keeps it in `sessionStorage` and
sends it only as `Authorization: Bearer` to `/v1` on the same origin.

- It survives a reload. A new tab asks for a token again.
- A browser may copy it into a duplicated or reopened tab. That is accepted.

To check a token, the console first calls `GET /v1/healthz` to learn whether
the daemon is up. It then calls `GET /v1/workers`, a read only an operator
may make, in both modes (ADR 0012).

| Answer | The console says |
| --- | --- |
| `200` | signed in |
| `401` | the token is unknown |
| `403` | the token is real but the console needs an operator token |
| no answer in 10 seconds, while `/v1/healthz` answers | the daemon is starting |
| `/v1/healthz` does not answer | the daemon cannot be reached |

A `401` at any later time signs the operator out.

The CSP in §4 is what makes `sessionStorage` acceptable: no script from
anywhere else can run on the page to read it.

### 7. Development

Contributors run Vite's dev server against a local daemon. It proxies `/v1`
to the daemon's HTTP port. The dev server is never part of the package and
the daemon never starts it.

## Consequences

- The console and the API always come from the same build, so they never
  disagree about a version.
- Same origin means no CORS, and the token never leaves the daemon's host
  and port.
- The package grows by the built console and its fonts.
- `pnpm build` now needs Vite and takes a few seconds longer. CI and the
  end-to-end suite build the console with everything else.
- Anyone who reaches the HTTP listener can load the console shell. They see
  nothing without a token.
- `HTTP-API.md` says every route needs a token except `GET /v1/healthz`. It
  gains the console's files as a second exception.
- The landing page can reuse the style, but not this hosting.

## Alternatives considered

- **Ship the source and run Vite's dev server in the daemon.** Rejected:
  Vite becomes a runtime dependency, start-up is slower, and a dev server is
  not built to face a network.
- **A separate package or a separate website.** Rejected: #88 lists both as
  non-goals. A separate origin also needs CORS and sends the token
  elsewhere.
- **Preact or no framework.** Smaller. Rejected: React is what Callstack and
  its contributors know, and the bundle is loaded from the daemon, so its
  size matters little.
- **Serve files from `app.ts`.** Rejected: `app.ts` stays free of the file
  system, so it is tested as a plain function.
- **The token in `localStorage`.** Rejected by the maintainer: a new tab
  should ask again.
- **A cookie session.** Rejected: it needs a login route and CSRF defence,
  and the API is bearer-only.
- **Hash-based page URLs instead of the `index.html` fallback.** Rejected:
  the fallback is one rule, and real paths read better in a link.
