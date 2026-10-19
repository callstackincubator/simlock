import { Worker } from "node:worker_threads";

import type { UsageOutput } from "../../contract/index.js";
import { usageBucket } from "./compute-usage.js";
import type { ReadRequest, ReadResponse } from "./read-thread.js";

export interface UsageGetInput {
  readonly from: number;
  readonly to: number;
  readonly includeLedger?: boolean | undefined;
}

export type UsageResult =
  | { readonly kind: "figures"; readonly usage: UsageOutput }
  | { readonly kind: "not-kept"; readonly oldestTs: number }
  | { readonly kind: "unavailable" };

export interface UsageReaderDeps {
  readonly historyPath: string;
  opened(): boolean;
  tokenLabels(): Promise<ReadonlyMap<string, string>>;
  workers(): readonly { readonly id: string; readonly label?: string | undefined }[];
  readonly fleet?: { readonly requesterPrefix: string };
}

export interface UsageReader {
  get(input: UsageGetInput): Promise<UsageResult>;
  stop(): Promise<void>;
}

const READ_TIMEOUT_MS = 30_000;

type Thread =
  | { readonly kind: "figures"; readonly figures: UsageOutput }
  | {
      readonly kind: "not-kept";
      readonly oldestTs: number;
    };

interface Pending {
  readonly worker: Worker;
  resolve(thread: Thread): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
}

// why: a worker thread runs the file natively, so a source run (tests) maps `.js` imports to `.ts` and strips types itself.
const SOURCE_LOADER = `export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e.code==="ERR_MODULE_NOT_FOUND"&&s.endsWith(".js"))return n(s.slice(0,-3)+".ts",c);throw e}}`;
const SOURCE_BOOT = `import{register}from"node:module";register("data:text/javascript,"+encodeURIComponent(${JSON.stringify(SOURCE_LOADER)}));`;

function startThread(): Worker {
  const fromSource = import.meta.url.endsWith(".ts");
  const url = new URL(fromSource ? "./read-thread.ts" : "./read-thread.js", import.meta.url);
  return fromSource
    ? new Worker(url, {
        execArgv: [
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          "--import",
          `data:text/javascript,${encodeURIComponent(SOURCE_BOOT)}`,
        ],
      })
    : new Worker(url);
}

export function createUsageReader(deps: UsageReaderDeps): UsageReader {
  let thread: Worker | undefined;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const inFlight = new Map<string, Promise<Thread>>();

  const failAll = (error: Error, owner?: Worker): void => {
    for (const [id, entry] of pending) {
      if (owner !== undefined && entry.worker !== owner) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  };

  const drop = (worker: Worker, error: Error): void => {
    if (thread === worker) thread = undefined;
    // why: a dropped thread's late exit must not reject the reads of the thread that replaced it.
    failAll(error, worker);
    void worker.terminate();
  };

  const ensureThread = (): Worker => {
    if (thread !== undefined) return thread;
    const worker = startThread();
    thread = worker;
    // why: an idle read thread must not keep the process alive.
    worker.unref();
    worker.on("message", (response: ReadResponse) => {
      const entry = pending.get(response.id);
      if (entry === undefined) return;
      pending.delete(response.id);
      clearTimeout(entry.timer);
      if ("error" in response) entry.reject(new Error(response.error));
      else if ("notKept" in response)
        entry.resolve({ kind: "not-kept", oldestTs: response.notKept });
      else entry.resolve({ figures: response.figures, kind: "figures" });
    });
    worker.on("error", (error: unknown) =>
      drop(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", () => drop(worker, new Error("The usage read thread exited")));
    return worker;
  };

  const read = (request: Omit<ReadRequest, "id">): Promise<Thread> =>
    new Promise<Thread>((resolve, reject) => {
      const worker = ensureThread();
      const id = (nextId += 1);
      const timer = setTimeout(
        () => drop(worker, new Error("The usage read thread did not answer in time")),
        READ_TIMEOUT_MS,
      );
      pending.set(id, { reject, resolve, timer, worker });
      worker.postMessage({ ...request, id } satisfies ReadRequest);
    });

  const labelled = async (usage: UsageOutput): Promise<UsageOutput> => {
    if (usage.requesters.length === 0 && (usage.requests ?? []).length === 0) return usage;
    const tokens = await deps.tokenLabels();
    const prefix = deps.fleet?.requesterPrefix;
    const labelOf = (id: string): string | undefined => {
      const own = prefix !== undefined && id.startsWith(prefix);
      return tokens.get(own ? id.slice(prefix.length) : id);
    };
    const requests = usage.requests?.map((entry) => {
      const label = labelOf(entry.requester);
      return label === undefined ? entry : { ...entry, label };
    });
    return {
      ...usage,
      requesters: usage.requesters.map((entry) => {
        const label = labelOf(entry.id);
        return label === undefined ? entry : { ...entry, label };
      }),
      ...(requests === undefined ? {} : { requests }),
    };
  };

  return {
    async get({ from, includeLedger, to }) {
      if (!deps.opened()) return { kind: "unavailable" };
      const bucket = usageBucket(from, to);
      const key = `${bucket.from}:${to}:${includeLedger === true}`;
      let running = inFlight.get(key);
      if (running === undefined) {
        const started = read({
          bucketMs: bucket.bucketMs,
          fleet: deps.fleet !== undefined,
          from: bucket.from,
          historyPath: deps.historyPath,
          includeLedger: includeLedger === true,
          to,
          workers: deps.workers(),
        });
        const settle = () => {
          if (inFlight.get(key) === started) inFlight.delete(key);
        };
        started.then(settle, settle);
        inFlight.set(key, started);
        running = started;
      }
      const answer = await running;
      return answer.kind === "not-kept"
        ? answer
        : { kind: "figures", usage: await labelled(answer.figures) };
    },
    async stop() {
      const worker = thread;
      thread = undefined;
      failAll(new Error("The usage reader was stopped"));
      if (worker !== undefined) await worker.terminate();
    },
  };
}
