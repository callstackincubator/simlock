import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import type { IpcConnector } from "../ports/index.js";
import { IpcDaemonConnection } from "./connection.js";
import type { DaemonConnection } from "./protocol.js";

export interface DaemonConnector {
  connect(): Promise<DaemonConnection>;
}

export class IpcDaemonConnector implements DaemonConnector {
  constructor(
    private readonly ipc: IpcConnector,
    private readonly endpoint: string,
  ) {}

  async connect(): Promise<DaemonConnection> {
    const transport = await this.ipc.connect(this.endpoint);
    const connection = new IpcDaemonConnection(transport);
    try {
      await connection.request("hello", {
        clientVersion: "1.0.0",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      });
      return connection;
    } catch (error: unknown) {
      await connection.close();
      throw error;
    }
  }
}
