import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

export interface ProcessRunOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<ProcessResult>;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessResult>;
  spawn(command: string, args: readonly string[], options?: ProcessRunOptions): ProcessHandle;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    const process = this.spawn(command, args, options);
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              process.kill("SIGTERM");
            } catch {
              // The child may have exited between the timer firing and the kill.
            }
          }, options.timeoutMs);

    try {
      return await process.wait();
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    const child = spawnChildProcess(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      stdio: "pipe",
    });

    return new NodeProcessHandle(child);
  }
}

class NodeProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #stdoutChunks: string[] = [];
  readonly #stderrChunks: string[] = [];
  readonly #result: Promise<ProcessResult>;

  constructor(private readonly child: ChildProcess) {
    if (child.pid === undefined) {
      throw new Error("Process did not provide a pid");
    }

    if (child.stdout === null || child.stderr === null) {
      throw new Error("Process was not started with stdout and stderr pipes");
    }

    this.pid = child.pid;
    captureLines(child.stdout, this.stdout, this.#stdoutChunks);
    captureLines(child.stderr, this.stderr, this.#stderrChunks);
    this.#result = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stderr: this.#stderrChunks.join(""), stdout: this.#stdoutChunks.join("") });
      });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (process.platform === "win32") {
      this.child.kill(signal);
      return;
    }

    try {
      process.kill(-this.pid, signal);
    } catch (error: unknown) {
      if (isNoSuchProcessError(error)) {
        return;
      }

      throw error;
    }
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessRunOptions;
}

export interface ProcessMatcher {
  readonly command: string | RegExp;
  readonly args: readonly (string | RegExp)[];
}

export interface ScriptedProcessExpectation {
  readonly match: ProcessMatcher;
  readonly result?: ProcessResult;
  readonly stdoutLines?: readonly string[];
  readonly stderrLines?: readonly string[];
  readonly hangs?: boolean;
}

export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  #nextPid = 1;
  readonly #expectations: ScriptedProcessExpectation[];

  constructor(expectations: readonly ScriptedProcessExpectation[]) {
    this.#expectations = [...expectations];
  }

  async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessResult> {
    return this.spawn(command, args, options).wait();
  }

  spawn(command: string, args: readonly string[], options: ProcessRunOptions = {}): ProcessHandle {
    const invocation = { args: [...args], command, options };
    this.calls.push(invocation);
    const expectation = this.#expectations.shift();

    if (expectation === undefined || !matches(expectation.match, invocation)) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }

    return new ScriptedProcessHandle(this.#nextPid++, expectation);
  }
}

class ScriptedProcessHandle implements ProcessHandle {
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #result: Promise<ProcessResult>;
  #resolve!: (result: ProcessResult) => void;
  #finished = false;

  constructor(
    readonly pid: number,
    private readonly expectation: ScriptedProcessExpectation,
  ) {
    this.#result = new Promise<ProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    this.#writeLines(expectation.stdoutLines, this.stdout);
    this.#writeLines(expectation.stderrLines, this.stderr);

    if (!expectation.hangs) {
      this.#finish(expectation.result ?? defaultResult(expectation));
    }
  }

  kill(_signal: NodeJS.Signals = "SIGTERM"): void {
    this.#finish({ code: null, stderr: "", stdout: "" });
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }

  #writeLines(lines: readonly string[] | undefined, destination: LineBuffer): void {
    for (const line of lines ?? []) {
      destination.push(line);
    }
  }

  #finish(result: ProcessResult): void {
    if (this.#finished) {
      return;
    }

    this.#finished = true;
    this.stdout.close();
    this.stderr.close();
    this.#resolve(result);
  }
}

class LineBuffer implements AsyncIterable<string> {
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

function captureLines(
  stream: NodeJS.ReadableStream,
  destination: LineBuffer,
  chunks: string[],
): void {
  let remainder = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    chunks.push(chunk);
    const completeLines = `${remainder}${chunk}`.split(/\r?\n/);
    remainder = completeLines.pop() ?? "";

    for (const line of completeLines) {
      destination.push(line);
    }
  });
  stream.on("end", () => {
    if (remainder !== "") {
      destination.push(remainder);
    }
    destination.close();
  });
}

function matches(matcher: ProcessMatcher, invocation: ProcessInvocation): boolean {
  return (
    matchesPart(matcher.command, invocation.command) &&
    matcher.args.length === invocation.args.length &&
    matcher.args.every((argument, index) => matchesPart(argument, invocation.args[index] ?? ""))
  );
}

function matchesPart(matcher: string | RegExp, value: string): boolean {
  return typeof matcher === "string" ? matcher === value : matcher.test(value);
}

function defaultResult(expectation: ScriptedProcessExpectation): ProcessResult {
  return {
    code: 0,
    stderr: (expectation.stderrLines ?? []).join("\n"),
    stdout: (expectation.stdoutLines ?? []).join("\n"),
  };
}

function isNoSuchProcessError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
