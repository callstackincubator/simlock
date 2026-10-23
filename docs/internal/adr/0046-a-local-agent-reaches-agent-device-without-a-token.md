# 0046. A local agent reaches agent-device without a token

- **Status:** Proposed
- **Date:** 2026-10-23
- **Issue:** [#952](https://github.com/callstackincubator/simlock/issues/952), from request #950
- **Narrows:** [ADR 0023](0023-agent-device-is-served-by-an-optional-edge-module.md)
  §4 ("One simlock token is one tenant"): on a standalone worker, a loopback
  caller with no credential is its own tenant, named by the session it sends.
  [ADR 0033](0033-a-sign-in-proxy-is-a-second-way-to-sign-in-and-auth-is-one-module.md)
  §2: a third strategy joins the chain, and a strategy may read the peer's
  address and the route it guards.
- **Builds on:** [ADR 0039](0039-joined-workers-refuse-their-own-http-listener.md)
  (joined workers keep HTTP off).

## Context

Draft in progress; the spec session for #952 is still collecting facts.

## Decision

1. On a standalone worker, `http.enabled` defaults to on (`127.0.0.1:4701`)
   and `capabilities.agent-device.enabled` defaults to on. A joined worker
   keeps both as today.
2. A request to `/v1/agent-device` from a loopback peer, with no
   `Authorization` header and an `x-agent-device-tenant` header, is an
   `agent` identity named after that tenant. No other route accepts it.
3. `http.loopbackTrust` (`session` by default, or `off`) turns rule 2 off
   for a shared Mac.

## Consequences

To come.

## Alternatives considered

To come.
