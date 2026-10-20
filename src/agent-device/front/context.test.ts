import { describe, expect, it } from "vitest";

import type { Logger } from "../../ports/index.js";
import type { Identity } from "../../auth/index.js";
import { exchange, type FrontContext } from "./context.js";

function rig(reply: () => Promise<Response>) {
  const warnings: { message: string; fields: unknown }[] = [];
  const logger = {
    warn: (message: string, fields: unknown) => warnings.push({ message, fields }),
  } as unknown as Logger;
  const context = { link: { forward: reply }, logger } as unknown as FrontContext;
  return { context, warnings };
}

const request = new Request("http://127.0.0.1/rpc", { method: "POST" });
const identity = {} as Identity;

describe("exchange", () => {
  it("a reply that is not JSON-RPC is logged with its status and the start of its body", async () => {
    const { context, warnings } = rig(() =>
      Promise.resolve(new Response(`bad gateway ${"x".repeat(900)}`, { status: 200 })),
    );

    const result = await exchange(context, request, identity, "allocate");

    expect(result.reading.kind).toBe("unusable");
    expect(warnings).toHaveLength(1);
    const fields = warnings[0]?.fields as { body: string; status: number };
    expect(fields.status).toBe(200);
    expect(fields.body.startsWith("bad gateway xxx")).toBe(true);
    expect(fields.body.length).toBe(500);
  });

  it("a usable success reply is not logged", async () => {
    const { context, warnings } = rig(() =>
      Promise.resolve(Response.json({ id: 1, jsonrpc: "2.0", result: { ok: true } })),
    );

    const result = await exchange(context, request, identity);

    expect(result.reading.kind).toBe("success");
    expect(warnings).toEqual([]);
  });
});
