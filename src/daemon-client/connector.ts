import { PROTOCOL_VERSION_RANGE } from "../contract/index.js";
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
        // Sent alongside `protocolRange` (ADR 0003 §6) so a legacy protocol-2 daemon, which
        // only ever compares this field for an exact match, still answers intelligibly instead
        // of choking on an unknown `protocolRange` key. A new daemon prefers `protocolRange`
        // and treats this bare number as `{n, n}` only when `protocolRange` is absent.
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        protocolRange: PROTOCOL_VERSION_RANGE,
        ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
      });
      return connection;
    } catch (error: unknown) {
      await connection.close();
      throw error;
    }
  }
}
