import { WebSocket } from "ws";

import { waitFor } from "./wait.js";

export interface InputSocket {
  readonly messages: { readonly tag: number; readonly body: unknown }[];
  send(tag: number, body: unknown): void;
  waitForTag(tag: number): Promise<unknown>;
  close(): void;
}

// why: a lease's input socket speaks one tag byte and UTF-8 JSON (serve-sim's messages), and the
// agent token goes in an `Authorization` header, which only a Node client can set.
export async function openInputSocket(
  port: number,
  leaseId: string,
  token: string,
): Promise<InputSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/v1/leases/${leaseId}/input`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const messages: InputSocket["messages"] = [];
  socket.on("message", (data: Buffer) => {
    const text = data.subarray(1).toString("utf8");
    messages.push({
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
      tag: data[0] ?? 0,
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    close: () => socket.close(),
    messages,
    send: (tag, body) =>
      socket.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))])),
    waitForTag: async (tag) => {
      await waitFor(() => messages.some((message) => message.tag === tag), {
        interval: 200,
        label: `input message 0x${tag.toString(16)}`,
        timeout: 30_000,
      });
      return messages.find((message) => message.tag === tag)?.body;
    },
  };
}
