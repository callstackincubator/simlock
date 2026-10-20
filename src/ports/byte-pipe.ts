import { spawn } from "node:child_process";
import { Readable } from "node:stream";

// why: `ProcessRunner` hands output out as text, which a video stream cannot survive, and closes or
// never offers the stdin a capture program treats as its liveness handle.
export interface BytePipeLauncher {
  start(command: string, args: readonly string[], options: BytePipeOptions): BytePipeProcess;
}

export interface BytePipeOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly onStderrLine?: (line: string) => void;
}

export interface BytePipeProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  // why: never rejects -- a program the OS refused to start resolves with `error` set, so a caller
  // has one place to learn how it ended.
  readonly exited: Promise<BytePipeExit>;
  closeStdin(): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface BytePipeExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: string;
}

export class NodeBytePipeLauncher implements BytePipeLauncher {
  start(command: string, args: readonly string[], options: BytePipeOptions): BytePipeProcess {
    const child = spawn(command, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    // why: a child that exits while stdin is being closed raises EPIPE on the pipe, which is the
    // stop having worked, not a failure anyone can act on.
    child.stdin.on("error", () => undefined);

    let partial = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") options.onStderrLine?.(line);
    });

    const exited = new Promise<BytePipeExit>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error: error.message, signal: null }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    return {
      closeStdin: () => {
        child.stdin.end();
      },
      exited,
      kill: (signal) => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    };
  }
}

export interface FakeBytePipeStart {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

// fallow-ignore-next-line unused-export -- the public shape of FakeBytePipeLauncher.last and .processes.
export class FakeBytePipeProcess implements BytePipeProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<BytePipeExit>;
  stdinClosed = false;
  stdinCloses = 0;
  readonly kills: string[] = [];
  exitOnStdinClose = true;
  readonly #onStderrLine: ((line: string) => void) | undefined;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (exit: BytePipeExit) => void;
  #ended = false;

  constructor(onStderrLine?: (line: string) => void) {
    this.#onStderrLine = onStderrLine;
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): void {
    if (!this.#ended) this.#controller.enqueue(bytes);
  }

  stderr(line: string): void {
    this.#onStderrLine?.(line);
  }

  exit(exit: BytePipeExit = { code: 0, signal: null }): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller.close();
    } catch {
      // why: a reader that already cancelled the stream has closed it; the exit still settles.
    }
    this.#resolveExit(exit);
  }

  closeStdin(): void {
    this.stdinClosed = true;
    this.stdinCloses += 1;
    if (this.exitOnStdinClose) this.exit();
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push(signal);
    this.exit({ code: null, signal });
  }
}

export class FakeBytePipeLauncher implements BytePipeLauncher {
  readonly starts: FakeBytePipeStart[] = [];
  readonly processes: FakeBytePipeProcess[] = [];

  start(command: string, args: readonly string[], options: BytePipeOptions): FakeBytePipeProcess {
    this.starts.push({ args: [...args], command, env: options.env });
    const process = new FakeBytePipeProcess(options.onStderrLine);
    this.processes.push(process);
    return process;
  }

  get last(): FakeBytePipeProcess {
    const process = this.processes.at(-1);
    if (process === undefined) throw new Error("No byte-pipe process was started");
    return process;
  }
}
