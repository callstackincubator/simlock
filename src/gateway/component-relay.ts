/**
 * ADR 0010 §7: a gateway installs a component on its workers by asking each one, at the same
 * time, with the worker's own `component.install`. The gateway decides nothing a worker decides
 * (architecture rule 10): no policy, no disk check, no join. Each worker answers for itself, and
 * this module turns those answers into one result per worker.
 *
 * Every target ends in exactly one outcome (architecture rule 12). A worker's answer, the uplink
 * closing under the call, and the backstop are the three ways a call ends; whichever comes first
 * settles that worker's result, and anything that arrives after it -- a late answer, a late
 * progress update -- is dropped. The relay never cancels a worker's install: detaching from the
 * call is all it does.
 */
import type { z } from "zod";

import {
  isSimlockError,
  OPERATIONS,
  WORKER_RESULT_MESSAGE_MAX_LENGTH,
  type ComponentProgress,
} from "../contract/index.js";
import { DispatchError } from "../daemon/dispatch.js";
import type { SimlockAdminClient } from "../admin/index.js";
import type { Clock } from "../ports/index.js";
import {
  liveClient,
  type FleetViews,
  type WorkerDirectory,
  type WorkerDispatchTarget,
} from "./fleet-ports.js";
import type { WorkerView } from "./worker-registry.js";

type RelayOperation = (typeof OPERATIONS)["worker.install-component"];
type RelayInput = z.infer<RelayOperation["input"]>;
type RelayOutput = z.infer<RelayOperation["output"]>;
type WorkerInstallResult = RelayOutput["results"][number];

const resultSchema = OPERATIONS["worker.install-component"].output.shape.results.element;

/**
 * What the gateway adds to a worker's own `downloads.timeoutMs` before it stops waiting for that
 * worker's answer. The worker's budget is the limit; this is only a backstop for a worker that
 * never answers at all (ADR 0010 §7).
 */
export const INSTALL_BACKSTOP_MARGIN_MS = 60_000;

export interface ComponentRelayOptions {
  readonly views: Pick<FleetViews, "view" | "views">;
  readonly directory: WorkerDirectory;
  readonly clock: Clock;
}

export interface ComponentRelayHooks {
  /** Called once, after every target is resolved and before any worker is asked. A refusal of
   * the whole call (`UNKNOWN_WORKER`, `WORKER_UNREACHABLE`) comes before it. */
  readonly onAsking?: (() => void) | undefined;
  /** Each worker's progress, with that worker's id, while its call is still open. */
  readonly onProgress?: ((progress: ComponentProgress, workerId: string) => void) | undefined;
}

/** A worker the relay will ask, with the budget its backstop is measured against. */
interface Target {
  readonly view: WorkerView;
  readonly link: WorkerDispatchTarget;
  readonly client: SimlockAdminClient;
  readonly timeoutMs: number;
}

/**
 * Asks every targeted worker to install `input.version` of `input.platform`, and answers with
 * one result per worker in ascending worker id once every target has one.
 */
export async function relayComponentInstall(
  options: ComponentRelayOptions,
  input: RelayInput,
  hooks: ComponentRelayHooks = {},
): Promise<RelayOutput> {
  const { targets, skipped } = resolveTargets(options, input.workers);
  hooks.onAsking?.();
  const asked = await Promise.all(
    targets.map((target) => askWorker(options.clock, target, input, hooks)),
  );
  return {
    results: [...asked, ...skipped].sort((left, right) =>
      left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0,
    ),
  };
}

/**
 * `"all"`: every known worker that can be asked is a target, and every other one is `skipped`.
 * Named ids: an unknown one fails the call with `UNKNOWN_WORKER`, and one that cannot be asked
 * fails it with `WORKER_UNREACHABLE`, both before any worker is asked.
 */
function resolveTargets(
  options: ComponentRelayOptions,
  workers: RelayInput["workers"],
): { readonly targets: readonly Target[]; readonly skipped: readonly WorkerInstallResult[] } {
  if (workers === "all") {
    const targets: Target[] = [];
    const skipped: WorkerInstallResult[] = [];
    for (const view of options.views.views()) {
      const target = askable(options.directory, view);
      if (typeof target === "string") {
        skipped.push(result(view, "skipped", { code: "WORKER_UNREACHABLE", message: target }));
      } else {
        targets.push(target);
      }
    }
    return { skipped, targets };
  }
  const views = workers.map((workerId) => {
    const view = options.views.view(workerId);
    if (view === undefined) {
      throw new DispatchError("UNKNOWN_WORKER", `Unknown worker: ${workerId}`, { workerId });
    }
    return view;
  });
  const targets = views.map((view) => {
    const target = askable(options.directory, view);
    if (typeof target === "string") {
      throw new DispatchError("WORKER_UNREACHABLE", target, { workerId: view.id });
    }
    return target;
  });
  return { skipped: [], targets };
}

/**
 * The one answer to "can this worker be asked": its uplink is open and compatible, and its config
 * has been read, which is where its own `downloads.timeoutMs` comes from. A drained worker can be:
 * draining stops new leases, not maintenance. The reason it cannot be asked, otherwise.
 */
function askable(directory: WorkerDirectory, view: WorkerView): Target | string {
  if (view.connection === "incompatible") {
    return `Worker ${view.id} speaks no protocol version this gateway supports`;
  }
  const link = directory.target(view.id);
  const client = liveClient(link);
  if (view.connection !== "connected" || link === undefined || client === undefined) {
    return `Worker ${view.id} is not connected`;
  }
  const timeoutMs = view.downloads?.timeoutMs;
  if (timeoutMs === undefined) {
    return `Worker ${view.id}'s config has not been read yet`;
  }
  return { client, link, timeoutMs, view };
}

/**
 * One worker's call. The backstop is that worker's own `downloads.timeoutMs` plus a minute,
 * measured from the send and never restarted (architecture rule 11). After an `installed`
 * answer the worker's view is refreshed with its catalog before the result counts, so the fleet
 * catalog lists the component by the time the relay answers -- unless that refresh failed or
 * the link closed, which `refresh` swallows; the next refresh brings it in then.
 */
async function askWorker(
  clock: Clock,
  target: Target,
  input: RelayInput,
  hooks: ComponentRelayHooks,
): Promise<WorkerInstallResult> {
  const settled = await new Promise<WorkerInstallResult>((resolve) => {
    let done = false;
    const finish = (value: WorkerInstallResult): void => {
      if (done) return;
      done = true;
      clock.cancel(backstop);
      resolve(value);
    };
    const backstop = clock.setTimer(target.timeoutMs + INSTALL_BACKSTOP_MARGIN_MS, () => {
      finish(
        result(target.view, "unknown", {
          code: "WORKER_UNREACHABLE",
          message: `Worker ${target.view.id} did not answer within its downloads.timeoutMs plus ${String(INSTALL_BACKSTOP_MARGIN_MS / 1000)}s; its install may still be running`,
        }),
      );
    });
    const onProgress = hooks.onProgress;
    // Sent at once; the async wrapper only turns a synchronous throw into a rejection, so every
    // way the call ends goes through `finish`.
    const call = (async () =>
      target.client.installComponent(
        { platform: input.platform, version: input.version },
        {
          onProgress: (progress) => {
            if (!done) onProgress?.(progress, target.view.id);
          },
        },
      ))();
    call.then(
      (answer) => {
        finish(
          bounded(target.view, result(target.view, answer.outcome, undefined, answer.version)),
        );
      },
      (error: unknown) => {
        finish(fromError(target.view, error));
      },
    );
  });
  if (settled.outcome === "installed") await target.link.refresh({ includeCatalog: true });
  return settled;
}

/**
 * A worker's error, as a result. `DAEMON_CONNECTION_LOST` is the gateway's own client reporting
 * that the uplink closed under the call: the worker never answered, and its install carries on,
 * so the result is `unknown`. `DOWNLOADS_DISABLED` is the worker's policy refusing. Anything else
 * the worker answered is `failed`, with its code and message.
 */
function fromError(view: WorkerView, error: unknown): WorkerInstallResult {
  if (isSimlockError(error)) {
    if (error.code === "DAEMON_CONNECTION_LOST") {
      return result(view, "unknown", {
        code: "WORKER_UNREACHABLE",
        message: `The uplink to worker ${view.id} closed before it answered; its install may still be running`,
      });
    }
    const outcome = error.code === "DOWNLOADS_DISABLED" ? "refused" : "failed";
    return bounded(view, result(view, outcome, { code: error.code, message: error.message }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return bounded(view, result(view, "failed", { code: "INTERNAL", message }));
}

/** A worker's answer is a claim (safety rule 10): its message is cut to the contract's bound,
 * and an answer that still does not fit the contract is `failed` rather than relayed. */
function bounded(view: WorkerView, value: WorkerInstallResult): WorkerInstallResult {
  const cut =
    value.error === undefined
      ? value
      : {
          ...value,
          error: {
            code: value.error.code,
            message: value.error.message.slice(0, WORKER_RESULT_MESSAGE_MAX_LENGTH),
          },
        };
  if (resultSchema.safeParse(cut).success) return cut;
  return result(view, "failed", {
    code: "INTERNAL",
    message: `Worker ${view.id} answered with a result outside the contract`,
  });
}

function result(
  view: WorkerView,
  outcome: WorkerInstallResult["outcome"],
  error?: NonNullable<WorkerInstallResult["error"]>,
  version?: string,
): WorkerInstallResult {
  return {
    workerId: view.id,
    ...(view.label === undefined ? {} : { label: view.label }),
    outcome,
    ...(version === undefined ? {} : { version }),
    ...(error === undefined ? {} : { error }),
  };
}
