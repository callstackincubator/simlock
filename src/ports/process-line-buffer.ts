import type { LineEnd } from "./process-runner-types.js";

export class LineBuffer implements AsyncIterable<string> {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string | undefined) => void> = [];
  #closed = false;

  push(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
      return;
    }

    this.#lines.push(line);
  }

  close(): void {
    this.#closed = true;

    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.(undefined);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    while (true) {
      const line = await this.#next();
      if (line === undefined) {
        return;
      }

      yield line;
    }
  }

  #next(): Promise<string | undefined> {
    const line = this.#lines.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }

    if (this.#closed) {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

/**
 * why: The one place process output is cut into lines, for the real handle and the scripted one.
 * `\r\n` is always a single line end. Under `"carriage-return-too"` a bare `\r` ends a line as
 * well, and empty lines are dropped -- which is also what keeps a `\r\n` pair split across two
 * chunks one line end rather than a line plus an empty one.
 */
export class LineSplitter {
  #remainder = "";

  constructor(private readonly lineEnd: LineEnd) {}

  feed(chunk: string): string[] {
    const parts = `${this.#remainder}${chunk}`.split(
      this.lineEnd === "carriage-return-too" ? /\r\n|\r|\n/ : /\r?\n/,
    );
    this.#remainder = parts.pop() ?? "";
    return this.#kept(parts);
  }

  end(): string[] {
    const tail = this.#remainder;
    this.#remainder = "";
    return tail === "" ? [] : this.#kept([tail]);
  }

  #kept(lines: string[]): string[] {
    return this.lineEnd === "carriage-return-too" ? lines.filter((line) => line !== "") : lines;
  }
}

export function captureLines(
  stream: NodeJS.ReadableStream | null,
  destination: LineBuffer,
  chunks: string[],
  lineEnd: LineEnd,
): void {
  // why: No stream means the child was spawned with its output detached (`stdio: "ignore"`, or a
  // log file taking both descriptors). Closing the buffer
  // straight away is what keeps `for await (const line of handle.stdout)` a loop that
  // ends immediately rather than one that never yields and never returns.
  if (stream === null) {
    destination.close();
    return;
  }

  const splitter = new LineSplitter(lineEnd);
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
    for (const line of splitter.feed(chunk)) {
      destination.push(line);
    }
  });
  stream.on("end", () => {
    for (const line of splitter.end()) {
      destination.push(line);
    }
    destination.close();
  });
}
