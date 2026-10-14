import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { UplinkTransportConnection } from "../ports/index.js";
import { WebSocketUplinkConnector, WebSocketUplinkListenerFactory } from "../ports/testing.js";

export async function startWebSocketPair(): Promise<{
  worker: UplinkTransportConnection;
  gateway: UplinkTransportConnection;
  close(): Promise<void>;
}> {
  const factory = new WebSocketUplinkListenerFactory();
  let accepted: ((connection: UplinkTransportConnection) => void) | undefined;
  const acceptedConnection = new Promise<UplinkTransportConnection>((resolve) => {
    accepted = resolve;
  });
  const listener = await factory.listen({
    accept: (uplink) => accepted?.(uplink.connection),
    authenticate: () => Promise.resolve("accept"),
  });
  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  factory.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const worker = await new WebSocketUplinkConnector().connect({
    token: "join",
    url: `ws://127.0.0.1:${String(port)}`,
    workerId: "wrk_1",
  });
  const gateway = await acceptedConnection;
  return {
    close: async () => {
      await worker.close();
      await gateway.close();
      await listener.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    gateway,
    worker,
  };
}
