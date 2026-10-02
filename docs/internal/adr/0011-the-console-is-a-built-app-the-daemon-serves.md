# 0011. The console is a built app the daemon serves at `/`

- **Status:** Proposed
- **Date:** 2026-10-02
- **Issue:** [#88](https://github.com/callstackincubator/simlock/issues/88)
- **Supersedes:** nothing.
- **Depends on:** [ADR 0005](0005-gateway-and-worker-modes.md), for the
  operator role and the fleet routes the console reads.

## Context

#88 asks for a web console that operators open in a browser. The daemon
serves it, nothing is fetched from the internet, and only an operator token
signs in. The console must look the same on a gateway and on a single host.

Three choices shape every task that builds it: what the console is made
with, how it reaches the browser, and how it holds the token. Each is
expensive to change once views are built on top of it.

## Decision

### 1. Source and build

The console is a React app in TypeScript, built with Vite. Its source lives
in `ui/` at the repository root, beside `src/`.

`pnpm build` builds it into `dist/ui`, after the TypeScript build. The
package already publishes `dist`, so `dist/ui` ships with it. React, Vite
and every other console library are dev dependencies. The published package
gains files, not runtime dependencies.

Nothing in the daemon reads `ui/`. The daemon serves only the built files.

### 2. Serving

The HTTP app serves `dist/ui` with `serveStatic` from
`@hono/node-server/serve-static`. The root is found from the module's own
URL, never from the working directory.

The console is served whenever HTTP is enabled, in both modes. There is no
config key for it.

- Routes under `/v1` do not change. An unknown `/v1` path is still a JSON
  `404`; it never falls back to the page.
- A `GET` outside `/v1` that matches no file answers `index.html`, so a page
  URL survives a reload.
- Console files need no token. They hold no data. Data comes only from
  `/v1`, which keeps its own auth.

### 3. Caching and headers

The build puts a content hash in every asset name. Assets are served with
`Cache-Control: public, max-age=31536000, immutable`. `index.html` is
served with `Cache-Control: no-cache`, so a new release shows on the next
load.

Every console response carries:

```
Content-Security-Policy: default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self' data:; font-src 'self';
  connect-src 'self'; manifest-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

No inline script. No inline `<style>` element.

### 4. Nothing from the internet

Fonts, icons and scripts are bundled. The fonts are Geist and Geist Mono
(OFL-1.1). `connect-src 'self'` makes the browser refuse any request to
another host, so this holds even if a dependency tries.

### 5. Sign-in

The operator pastes a token. The console keeps it in `sessionStorage`: it
survives a reload and is gone when the tab closes. It is sent only as
`Authorization: Bearer` to `/v1` on the same origin.

At sign-in the console makes one read that only an operator may make.

- `401` means an unknown token.
- `403` means the token is real but is not an operator token. The console
  says it needs one.

A `401` at any later time signs the operator out.

The CSP in §3 is what makes `sessionStorage` acceptable: no script from
anywhere else can run on the page to read it.

### 6. Development

Contributors run Vite's dev server against a local daemon. It proxies
`/v1` to the daemon's HTTP port. The dev server is never part of the
package and the daemon never starts it.

## Consequences

- The console and the API always come from the same build, so they never
  disagree about a version.
- Same origin means no CORS, and the token never leaves the daemon's host
  and port.
- The package grows by the built console and its fonts.
- `pnpm build` now needs Vite. CI and the end-to-end suite build the
  console with everything else.
- Anyone who reaches the HTTP listener can load the console shell. They see
  nothing without a token.
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
- **The token in `localStorage`.** Rejected by the maintainer: closing the
  tab signs out.
- **A cookie session.** Rejected: it needs a login route and CSRF defence,
  and the API is bearer-only.
- **Hash-based page URLs instead of the `index.html` fallback.** Rejected:
  the fallback is one rule, and real paths read better in a link.
