import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { createMcpServer } from "./server.js";
import { McpSession } from "./session.js";
import { FakeSimlockClient, sampleGrant } from "./test-support.js";
import { call } from "./test-server.js";

describe("MCP lease_simulator: requires", () => {
  it("is listed in the input schema, sends requires locally, sends it with the idempotency key to a farm, and sends none when none is given", async () => {
    const clock = new FakeClock();
    const rows = [
      {
        name: "local",
        farm: false,
        input: { requires: ["bank-network"] },
        requires: ["bank-network"],
      },
      {
        name: "farm",
        farm: true,
        input: { requires: ["bank-network", "eu-west"] },
        requires: ["bank-network", "eu-west"],
      },
      { name: "none given", farm: false, input: {}, requires: undefined },
    ];
    for (const row of rows) {
      const client = new FakeSimlockClient();
      client.requestLeaseImpl = () => Promise.resolve(sampleGrant());
      client.releaseLeaseImpl = (input) => Promise.resolve({ leaseId: input.leaseId });
      const session = new McpSession({
        clock,
        connect: async () => client,
        connectForRenew: async () => client,
        ...(row.farm
          ? { farm: { origin: "https://farm.example.com", requesterId: "agent-a" } }
          : {}),
      });
      const server = createMcpServer(session, { clock });
      const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
      try {
        const tools = await mcpClient.request({ method: "tools/list" }, ListToolsResultSchema);
        const listed = tools.tools.find((tool) => tool.name === "lease_simulator");
        expect(Object.keys(listed?.inputSchema.properties ?? {}), row.name).toContain("requires");
        const result = await call(mcpClient, "lease_simulator", {
          platform: "android",
          ...row.input,
        });
        expect(result.isError, row.name).not.toBe(true);
        const sent = client.calls.find((entry) => entry.method === "requestLease")?.input as Record<
          string,
          unknown
        >;
        if (row.requires === undefined) expect(sent, row.name).not.toHaveProperty("requires");
        else expect(sent, row.name).toMatchObject({ requires: row.requires });
        if (row.farm) expect(sent, row.name).toHaveProperty("idempotencyKey", expect.any(String));
      } finally {
        await Promise.all([mcpClient.close(), server.close(), session.close()]);
      }
    }
  });
});
