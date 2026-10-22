import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { healthzRoute } from "./route-declarations.js";

describe("declareRoute", () => {
  it("a handler that returns a reply its declaration does not allow fails the typecheck", async () => {
    const app = new OpenAPIHono();

    app.openapi(healthzRoute, (c) => c.json({ ok: true as const }, 200));
    // @ts-expect-error -- why: `ok` is declared `true`, so this reply must not typecheck.
    app.openapi({ ...healthzRoute, path: "/v1/wrong" }, (c) => c.json({ ok: "yes" }, 200));

    const answer = await app.request("/v1/healthz");
    expect(await answer.json()).toEqual({ ok: true });
  });
});
