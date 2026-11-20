import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { FakeClock } from "../ports/index.js";
import { FakeSimlockClient } from "./test-support.js";
import { McpSession } from "./session.js";
import { createMcpServer } from "./server.js";

export async function connectedServer(client: FakeSimlockClient) {
  const clock = new FakeClock();
  const session = new McpSession({
    clock,
    connect: async () => client,
    connectForRenew: async () => client,
  });
  const server = createMcpServer(session, { clock });
  const mcpClient = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  return {
    clock,
    close: async () => {
      await Promise.all([mcpClient.close(), server.close(), session.close()]);
    },
    mcpClient,
  };
}

export function call(client: Client, name: string, arguments_: Record<string, unknown>) {
  return client.request(
    { method: "tools/call", params: { arguments: arguments_, name } },
    CallToolResultSchema,
  );
}

export function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) throw new Error("Expected text result");
  return first.text;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 0));
}
