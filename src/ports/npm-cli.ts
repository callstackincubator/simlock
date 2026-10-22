import { dirname, join } from "node:path";

import type { Filesystem } from "./filesystem.js";
import type { ProcessRunner } from "./process-runner.js";

export type NpmOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly message: string };

export interface NpmCli {
  view(spec: string): Promise<NpmOutcome>;
  install(spec: string): Promise<NpmOutcome>;
  globalRoot(): Promise<NpmOutcome>;
}

export interface NpmCall {
  readonly method: "view" | "install" | "globalRoot";
  readonly spec: string | undefined;
}

export class FakeNpmCli implements NpmCli {
  readonly calls: NpmCall[] = [];
  readonly #script: Record<NpmCall["method"], NpmOutcome[]>;

  constructor(script: Partial<Record<NpmCall["method"], readonly NpmOutcome[]>> = {}) {
    this.#script = {
      view: [...(script.view ?? [])],
      install: [...(script.install ?? [{ ok: true, output: "" }])],
      globalRoot: [...(script.globalRoot ?? [])],
    };
  }

  // fallow-ignore-next-line unused-class-member -- the daemon's update call (#836) resolves a version with it.
  async view(spec: string): Promise<NpmOutcome> {
    return this.#answer("view", spec);
  }

  async install(spec: string): Promise<NpmOutcome> {
    return this.#answer("install", spec);
  }

  async globalRoot(): Promise<NpmOutcome> {
    return this.#answer("globalRoot", undefined);
  }

  #answer(method: NpmCall["method"], spec: string | undefined): NpmOutcome {
    this.calls.push({ method, spec });
    const queue = this.#script[method];
    const outcome = queue.length > 1 ? queue.shift() : queue[0];
    if (outcome === undefined) {
      throw new Error(`FakeNpmCli has no answer for ${method}`);
    }
    return outcome;
  }
}

export interface NodeNpmCliOptions {
  readonly runner: ProcessRunner;
  readonly filesystem: Filesystem;
  readonly dataDirectory: string;
  readonly execPath?: string;
}

const SHORT_LIMIT_MS = 30_000;
const INSTALL_LIMIT_MS = 10 * 60_000;
const MESSAGE_CHARACTERS = 2000;

export class NodeNpmCli implements NpmCli {
  constructor(private readonly options: NodeNpmCliOptions) {}

  async view(spec: string): Promise<NpmOutcome> {
    return this.#run(["view", spec, "version"], SHORT_LIMIT_MS, "30 seconds");
  }

  async install(spec: string): Promise<NpmOutcome> {
    return this.#run(["i", "-g", spec], INSTALL_LIMIT_MS, "10 minutes");
  }

  async globalRoot(): Promise<NpmOutcome> {
    return this.#run(["root", "-g"], SHORT_LIMIT_MS, "30 seconds");
  }

  async #run(args: readonly string[], timeoutMs: number, limit: string): Promise<NpmOutcome> {
    const node = this.options.execPath ?? process.execPath;
    const script = await this.options.filesystem.realpath(join(dirname(node), "npm"));
    const result = await this.options.runner.run(node, [script, ...args], {
      cwd: this.options.dataDirectory,
      timeoutMs,
    });
    if (result.code === null) {
      return { ok: false, message: `npm did not finish within ${limit}` };
    }
    if (result.code !== 0) {
      return { ok: false, message: result.stderr.trim().slice(-MESSAGE_CHARACTERS) };
    }
    return { ok: true, output: result.stdout.trim() };
  }
}
