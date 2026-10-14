import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { withHttpDaemon } from "./http-daemon.js";
import { freeLoopbackPort } from "./port.js";

describe("withHttpDaemon", () => {
  it("when the first port it picks is already taken, returns a daemon whose HTTP listener answers on the next one", async () => {
    const holder = createServer();
    const taken = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    try {
      const picked: number[] = [];
      const { env, port } = await withHttpDaemon(
        (pickedPort) => ({
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port: pickedPort } },
        }),
        async () => {
          const next = picked.length === 0 ? taken : await freeLoopbackPort();
          picked.push(next);
          return next;
        },
      );

      expect(picked[0]).toBe(taken);
      expect(port).toBe(picked[1]);
      expect((await fetch(`http://127.0.0.1:${String(port)}/v1/healthz`)).ok).toBe(true);
      expect((await env.cli(["status"])).code).toBe(0);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });
});
