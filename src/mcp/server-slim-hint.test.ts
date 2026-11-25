import { describe, expect, it, vi } from "vitest";
import { SimlockError } from "../client/index.js";
import type { FakeClock } from "../ports/index.js";
import { leaseSimulatorOutputSchema } from "./contracts.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { call, connectedServer } from "./test-server.js";

const CATEGORIES = ["mdm", "store", "other", "siri", "widgets", "push", "spotlight", "icloud"];

function iosCatalog(slimCategories: readonly string[]) {
  return {
    platforms: [
      {
        platform: "ios" as const,
        models: [],
        runtimes: [],
        modelRuntimes: {},
        modelAliases: {},
        modelClasses: {},
        classDefaults: {},
        slimCategories: [...slimCategories],
      },
    ],
  };
}

const slimGrant = (except?: string[]) => {
  const grant = sampleGrant();
  return {
    ...grant,
    device: { ...grant.device, mode: "slim" as const, ...(except ? { except } : {}) },
  };
};

const hintFor = (names: readonly string[]): string =>
  `slim: ${names.join(", ")} off; pass except: ["<name>"] or mode: "full"`;

describe("MCP lease_simulator: the slim hint", () => {
  it("answers hint naming the slim categories a slim iOS lease has off, and none otherwise, with the grant otherwise unchanged", async () => {
    const rows = [
      { name: "all categories", grant: slimGrant(), input: {}, hint: hintFor(CATEGORIES) },
      {
        name: "except store",
        grant: slimGrant(["store"]),
        input: { except: ["store"] },
        hint: hintFor(CATEGORIES.filter((name) => name !== "store")),
      },
      { name: "full", grant: sampleGrant(), input: {}, hint: undefined },
      {
        name: "Android",
        grant: {
          ...slimGrant(),
          device: {
            ...slimGrant().device,
            spec: {
              model: "Pixel 8",
              osVersion: "35",
              physical: false,
              platform: "android" as const,
            },
          },
        },
        input: {},
        hint: undefined,
      },
      {
        name: "catalog read rejects",
        grant: slimGrant(),
        input: {},
        hint: undefined,
        read: "reject",
      },
      {
        name: "catalog unanswered past 2 s",
        grant: slimGrant(),
        input: {},
        hint: undefined,
        read: "hang",
      },
    ] as const;
    for (const row of rows) {
      const client = new FakeSimlockClient();
      client.requestLeaseImpl = () => Promise.resolve(row.grant);
      let catalogAsked = false;
      client.getCatalogImpl = () => {
        catalogAsked = true;
        if ("read" in row && row.read === "reject") {
          return Promise.reject(new SimlockError("INTERNAL", "domain", "catalog failed", {}));
        }
        if ("read" in row && row.read === "hang") return new Promise(() => undefined);
        return Promise.resolve(iosCatalog(CATEGORIES));
      };
      const { clock, close, mcpClient } = await connectedServer(client);
      try {
        let done = false;
        const pending = call(mcpClient, "lease_simulator", { platform: "ios", ...row.input }).then(
          (result) => {
            done = true;
            return result;
          },
        );
        // why: the hint waits at most 2 s of fake time from its catalog read, so the waits advance
        // the clock by no more than that once the read began.
        let advanced = 0;
        await vi.waitFor(
          () => {
            if (catalogAsked && advanced < 2_000) {
              (clock as FakeClock).advance(500);
              advanced += 500;
            }
            expect(done, `${row.name}: the call has not answered`).toBe(true);
          },
          { timeout: 10_000 },
        );
        const result = await pending;
        expect(result.isError, row.name).not.toBe(true);
        const { hint, ...rest } = result.structuredContent as Record<string, unknown>;
        expect(hint, row.name).toEqual(row.hint);
        expect(rest, row.name).toEqual(row.grant);
        expect(leaseSimulatorOutputSchema.parse(result.structuredContent), row.name).toEqual(
          result.structuredContent,
        );
      } finally {
        await close();
      }
    }
  });
});
