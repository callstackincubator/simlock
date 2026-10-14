import type { Clock, IpcConnection, Logger, UplinkTransportConnection } from "../ports/index.js";

export type LinkChannelErrorReason =
  | "aborted"
  | "invalid"
  | "not-accepted"
  | "stalled"
  | "closed"
  | "stopped";

export class LinkChannelError extends Error {
  constructor(
    readonly reason: LinkChannelErrorReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "LinkChannelError";
  }
}

export interface LinkChannel {
  readonly id: string;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  abort(reason?: string): void;
  readonly credit: number;
  whenCredit(): Promise<void>;
}

export interface LinkConnection extends IpcConnection {
  openChannel(options: { readonly signal: AbortSignal }): Promise<LinkChannel>;
  acceptChannel(id: string): LinkChannel;
}

export interface LinkOptions {
  readonly end: "worker" | "gateway";
  readonly clock: Clock;
  readonly logger: Logger;
  readonly firstChannelNumber?: number;
}

export function createLink(
  _transport: UplinkTransportConnection,
  _options: LinkOptions,
): LinkConnection {
  return {
    closed: false,
    onData: () => () => {},
    onClose: () => () => {},
    onError: () => () => {},
    write: async () => {},
    close: async () => {},
    openChannel: () => Promise.reject(new Error("the link module is not built yet")),
    acceptChannel: (id) => ({
      abort: () => {},
      credit: 0,
      id,
      readable: new ReadableStream<Uint8Array>({
        start: (controller) => controller.error(new LinkChannelError("closed")),
      }),
      whenCredit: () => Promise.resolve(),
      writable: new WritableStream<Uint8Array>(),
    }),
  };
}
