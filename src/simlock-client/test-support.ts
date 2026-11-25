import type { IpcConnection } from "../ports/index.js";

export interface SentFrame {
  readonly id: number | string;
  readonly type: string;
  readonly payload: unknown;
}

export class ScriptedConnection implements IpcConnection {
  readonly sent: SentFrame[] = [];
  #closed = false;
  readonly #dataListeners = new Set<(chunk: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();

  get closed(): boolean {
    return this.#closed;
  }

  onData(listener: (chunk: string) => void): () => void {
    this.#dataListeners.add(listener);
    return () => this.#dataListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  write(contents: string): Promise<void> {
    for (const line of contents.split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as { id: number | string; type: string; payload: unknown };
      this.sent.push(frame);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#simulateClose();
    return Promise.resolve();
  }

  receive(frame: unknown): void {
    for (const listener of this.#dataListeners) listener(`${JSON.stringify(frame)}\n`);
  }

  /** why: a line split across chunks needs the text fed with no newline added. */
  receiveRaw(text: string): void {
    for (const listener of this.#dataListeners) listener(text);
  }

  receiveLine(line: string): void {
    for (const listener of this.#dataListeners) listener(`${line}\n`);
  }

  reply(id: number | string, payload: unknown): void {
    this.receive({ id, ok: true, payload });
  }

  fail(id: number | string, code: string, message = code, details?: unknown): void {
    this.receive({ error: { code, details, message }, id, ok: false });
  }

  push(kind: string, payload: unknown): void {
    this.receive({ payload, push: kind });
  }

  lastSentOf(type: string): SentFrame | undefined {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const frame = this.sent[index];
      if (frame !== undefined && frame.type === type) return frame;
    }
    return undefined;
  }

  simulateDeath(): void {
    this.#simulateClose();
  }

  #simulateClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

export function completeHello(
  connection: ScriptedConnection,
  options: {
    readonly role?: "agent" | "admin";
    readonly version?: string;
    readonly principal?: string;
  } = {},
): void {
  const hello = connection.lastSentOf("hello");
  if (hello === undefined) throw new Error("Expected the client to have sent hello already");
  const sentPrincipal = (hello.payload as { principal?: string }).principal;
  connection.reply(hello.id, {
    daemonProtocolRange: { max: 3, min: 3 },
    principal: options.principal ?? sentPrincipal ?? "default-principal",
    protocolVersion: 3,
    role: options.role ?? "agent",
    version: options.version ?? "0.3.0",
  });
}
