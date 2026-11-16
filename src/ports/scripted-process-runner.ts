import { LineBuffer, LineSplitter } from "./process-line-buffer.js";
import {
  InputStreamFailedError,
  type LineEnd,
  type ProcessHandle,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunner,
  type ProcessStreamOptions,
  type StreamingProcessHandle,
  type StreamingProcessResult,
} from "./process-runner-types.js";

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
  /**
   * why: Raw chunks for `spawnStreaming`, emitted in this exact order across both streams --
   * which `stdoutLines`/`stderrLines` cannot express, since they are two separate lists with
   * no ordering between them. A test asserting that interleaved output reaches a caller in
   * arrival order needs that, so it is stated here rather than inferred. When absent,
   * `spawnStreaming` falls back to the line lists (stdout then stderr, newline-terminated).
   * `spawn` replays them too, in place of the line lists, through the same line splitting a
   * real child's output gets -- so a test can say exactly where one chunk ends.
   */
  readonly chunks?: readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[];
  /**
   * why: Models a child that ignores `SIGTERM` -- only `SIGKILL` ends it. Without this a scripted
   * `hangs` process dies on the first signal, so the escalation every timeout path depends on
   * (`SIGTERM`, then `SIGKILL` after a grace window) is never actually exercised: the code that
   * sends the second signal would be dead and nothing would notice.
   */
  readonly ignoresSigterm?: boolean;
  readonly onSpawn?: (args: readonly string[]) => void | Promise<void>;
}

export class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: ProcessInvocation[] = [];
  /**
   * why: The handle each `spawn` returned, so a test can assert what the caller did *with*
   * the child rather than only how it was started. `unref` is the case
   * that needs it: nothing about the argv or the options says whether the event loop was
   * released, and a spawned child that stays referenced keeps the daemon alive after
   * `daemon stop`.
   */
  readonly handles: (ProcessHandle & { readonly unreffed: boolean })[] = [];
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

    void expectation.onSpawn?.([...args]);
    const handle = new ScriptedProcessHandle(
      this.#nextPid++,
      expectation,
      options.lineEnd ?? "newline",
    );
    this.handles.push(handle);
    return handle;
  }

  spawnStreaming(
    command: string,
    args: readonly string[],
    options: ProcessStreamOptions,
  ): StreamingProcessHandle {
    const invocation = {
      args: [...args],
      command,
      // why: Recorded as a `ProcessRunOptions` so `calls` stays one list a test can read uniformly;
      // `onChunk` is a callback, not configuration, and nothing would assert on it.
      options: {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.input === undefined ? {} : { input: options.input }),
      },
    };
    this.calls.push(invocation);
    const expectation = this.#expectations.shift();

    if (expectation === undefined || !matches(expectation.match, invocation)) {
      throw new Error(`Unexpected process invocation: ${command} ${args.join(" ")}`);
    }

    return new ScriptedStreamingProcessHandle(
      this.#nextPid++,
      expectation,
      options.onChunk,
      options.inputStream,
    );
  }
}

/**
 * why: The scripted counterpart of `NodeStreamingProcessHandle`: emits the expectation's chunks
 * synchronously (so a test needs no timers to see them), then settles unless the expectation
 * `hangs` -- in which case only `kill()` settles it, reporting the signal the way a real
 * killed child does. That is what makes the daemon's exec timeout testable without a real
 * process or a real clock.
 */
class ScriptedStreamingProcessHandle implements StreamingProcessHandle {
  inputFailed?: Promise<never>;
  readonly #result: Promise<StreamingProcessResult>;
  #resolve!: (result: StreamingProcessResult) => void;
  #finished = false;

  readonly #ignoresSigterm: boolean;

  constructor(
    readonly pid: number,
    expectation: ScriptedProcessExpectation,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
    inputStream?: ReadableStream<Uint8Array>,
  ) {
    this.#ignoresSigterm = expectation.ignoresSigterm ?? false;
    if (inputStream !== undefined) this.inputFailed = scriptedInputFailure(inputStream);
    this.#result = new Promise<StreamingProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    void this.#deliver(expectation, onChunk);
  }

  /**
   * why: One chunk at a time, awaiting each delivery before the next -- the same discipline
   * `NodeStreamingProcessHandle` gets by pausing a readable, so a test that stalls a delivery
   * sees the scripted child stall too rather than racing ahead of it. The command settles only
   * once its output is delivered, which keeps "output, then exit code" true here as well.
   */
  async #deliver(
    expectation: ScriptedProcessExpectation,
    onChunk: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>,
  ): Promise<void> {
    for (const { chunk, stream } of scriptedChunks(expectation)) {
      if (this.#finished) return;
      await onChunk(stream, chunk);
    }
    if (!expectation.hangs) {
      this.#finish({ code: expectation.result?.code ?? 0, signal: null });
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.#ignoresSigterm && signal !== "SIGKILL") return;
    this.#finish({ code: null, signal });
  }

  wait(): Promise<StreamingProcessResult> {
    return this.#result;
  }

  #finish(result: StreamingProcessResult): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#resolve(result);
  }
}

/** why: the scripted child reads its whole input at once, so a test sees a failing stream reject `inputFailed` as the real adapter does. */
function scriptedInputFailure(source: ReadableStream<Uint8Array>): Promise<never> {
  const failed = new Promise<never>((_resolve, reject) => {
    void (async () => {
      const reader = source.getReader();
      let read = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) return;
          read += result.value.byteLength;
        }
      } catch (error) {
        reject(new InputStreamFailedError(read, error));
      }
    })();
  });
  failed.catch(() => undefined);
  return failed;
}

function scriptedChunks(
  expectation: ScriptedProcessExpectation,
): readonly { readonly stream: "stdout" | "stderr"; readonly chunk: string }[] {
  if (expectation.chunks !== undefined) return expectation.chunks;
  return [
    ...(expectation.stdoutLines ?? []).map((line) => ({
      chunk: `${line}\n`,
      stream: "stdout" as const,
    })),
    ...(expectation.stderrLines ?? []).map((line) => ({
      chunk: `${line}\n`,
      stream: "stderr" as const,
    })),
  ];
}

class ScriptedProcessHandle implements ProcessHandle {
  unreffed = false;
  readonly stdout = new LineBuffer();
  readonly stderr = new LineBuffer();
  readonly #result: Promise<ProcessResult>;
  #resolve!: (result: ProcessResult) => void;
  #finished = false;

  constructor(
    readonly pid: number,
    private readonly expectation: ScriptedProcessExpectation,
    lineEnd: LineEnd,
  ) {
    this.#result = new Promise<ProcessResult>((resolve) => {
      this.#resolve = resolve;
    });
    if (expectation.chunks === undefined) {
      this.#writeLines(expectation.stdoutLines, this.stdout, lineEnd);
      this.#writeLines(expectation.stderrLines, this.stderr, lineEnd);
    } else {
      this.#writeChunks(expectation.chunks, lineEnd);
    }

    if (!expectation.hangs) {
      this.#finish(expectation.result ?? defaultResult(expectation));
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.expectation.ignoresSigterm === true && signal !== "SIGKILL") return;
    this.#finish({ code: null, stderr: "", stdout: "" });
  }

  unref(): void {
    this.unreffed = true;
  }

  wait(): Promise<ProcessResult> {
    return this.#result;
  }

  /**
   * why: Each scripted line is replayed as the child would have printed it, `\n`-terminated, through
   * the same splitter the real handle uses -- so a scripted line holding `\r` redraws splits
   * exactly as real output would under the caller's `lineEnd`.
   */
  #writeLines(
    lines: readonly string[] | undefined,
    destination: LineBuffer,
    lineEnd: LineEnd,
  ): void {
    const splitter = new LineSplitter(lineEnd);
    for (const line of lines ?? []) {
      for (const split of splitter.feed(`${line}\n`)) destination.push(split);
    }
  }

  #writeChunks(chunks: NonNullable<ScriptedProcessExpectation["chunks"]>, lineEnd: LineEnd): void {
    const splitters = { stderr: new LineSplitter(lineEnd), stdout: new LineSplitter(lineEnd) };
    for (const { chunk, stream } of chunks) {
      for (const line of splitters[stream].feed(chunk)) this[stream].push(line);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      for (const line of splitters[stream].end()) this[stream].push(line);
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
  if (expectation.chunks !== undefined) {
    const text = (stream: "stdout" | "stderr"): string =>
      expectation.chunks
        ?.filter((chunk) => chunk.stream === stream)
        .map(({ chunk }) => chunk)
        .join("") ?? "";
    return { code: 0, stderr: text("stderr"), stdout: text("stdout") };
  }
  return {
    code: 0,
    stderr: (expectation.stderrLines ?? []).join("\n"),
    stdout: (expectation.stdoutLines ?? []).join("\n"),
  };
}
