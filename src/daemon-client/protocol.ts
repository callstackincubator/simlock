export interface DaemonConnection {
  request(type: string, payload: unknown): Promise<unknown>;
  onPush(listener: (kind: string, payload: unknown) => void): () => void;
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
