export interface DaemonConnection {
  request(type: string, payload: unknown): Promise<unknown>;
  onPush(listener: (kind: string, payload: unknown) => void): () => void;
  /** Fires exactly once, whenever the connection closes — from a live socket drop or from `close()`. */
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export class DaemonClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonClientError";
  }
}
