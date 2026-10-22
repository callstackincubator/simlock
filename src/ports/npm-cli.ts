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
