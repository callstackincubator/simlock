// why: the port the daemon's session path talks to, so neither the daemon nor http imports `ws`
// (only the upgrade router does). One text message is one protocol line, without its `\n`; the
// connection hands the daemon the same chunks a unix socket would.
import type { IpcConnection } from "./ipc.js";

export interface SessionConnection extends IpcConnection {
  // why: a session ends with a code the caller can read (4001 identity expired, 4003 token revoked), which `IpcConnection.close` cannot carry.
  closeWith(code: number, reason: string): void;
}

export type SessionAccept = (connection: SessionConnection) => void;

// why: what the upgrade router needs of a session request: the refusal to send before the
// upgrade, or the accept to run on the upgraded socket, with the instant the identity ends.
export type SessionOutcome =
  | { readonly response: Response }
  | { readonly accept: SessionAccept; readonly expiresAt?: number };
