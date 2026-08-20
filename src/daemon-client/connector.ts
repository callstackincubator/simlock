import { DAEMON_PROTOCOL_VERSION } from "../daemon-protocol/index.js";
import type { IpcConnector } from "../ports/index.js";
import { IpcDaemonConnection } from "./connection.js";
import type { DaemonConnection } from "./protocol.js";

export interface DaemonConnector {
  connect(): Promise<DaemonConnection>;
}

/** Client capabilities negotiated at `hello`. A missing/false flag declares nothing. */
export interface DaemonClientCapabilities {
  readonly heartbeat?: boolean;
}

export class IpcDaemonConnector implements DaemonConnector {
  constructor(
    private readonly ipc: IpcConnector,
    private readonly endpoint: string,
    private readonly capabilities?: DaemonClientCapabilities,
  ) {}

  async connect(): Promise<DaemonConnection> {
    const transport = await this.ipc.connect(this.endpoint);
    const connection = new IpcDaemonConnection(transport);
    try {
      await connection.request("hello", {
        clientVersion: "1.0.0",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
      });
      return connection;
    } catch (error: unknown) {
      await connection.close();
      throw error;
    }
  }
}
