// why: the port a module's lease socket handler talks to, so no module imports `ws` (only the upgrade
// router and the uplink adapter do). Messages are binary; a close carries a code and a reason the
// caller has already cut to 123 bytes.
export interface LeaseSocket {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(listener: (data: Uint8Array) => void): void;
  onClose(listener: () => void): void;
}

// why: what a module hands the upgrade router once it has opened what a socket needs (a gateway's relay
// to the worker): `abandon` releases it when the handshake fails and no socket ever arrives.
export type LeaseSocketAccept = ((socket: LeaseSocket) => void) & {
  readonly abandon?: () => void;
};

// why: the in-memory end of a `LeaseSocket` for tests: `sent` records what the module wrote and
// `closed` how it closed; `receive` and `drop` play the client.
export class MemoryLeaseSocket implements LeaseSocket {
  readonly sent: Uint8Array[] = [];
  closed: { readonly code: number; readonly reason: string } | undefined;
  readonly #messageListeners: ((data: Uint8Array) => void)[] = [];
  readonly #closeListeners: (() => void)[] = [];

  send(data: Uint8Array): void {
    if (this.closed === undefined) this.sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.closed !== undefined) return;
    this.closed = { code, reason };
    this.drop();
  }

  onMessage(listener: (data: Uint8Array) => void): void {
    this.#messageListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  receive(data: Uint8Array): void {
    for (const listener of this.#messageListeners) listener(data);
  }

  drop(): void {
    for (const listener of this.#closeListeners.splice(0)) listener();
  }
}
