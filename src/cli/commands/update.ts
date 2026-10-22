import type { SimlockAdminClient } from "../../admin/index.js";
import { isSimlockError, updateRequestedVersionSchema } from "../../contract/index.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import { waitForTermination } from "../termination.js";
import type { CommandContext } from "../tree.js";

const POLL_MS = 1_000;
const COME_BACK_MS = 15 * 60_000;
const USAGE = "Usage: simlock update [--version <version>] [--force] [--json]\n";

type Answer = Awaited<ReturnType<SimlockAdminClient["updateDaemon"]>>;
type UpdateState = NonNullable<Answer["update"]>;

function plural(count: number): string {
  return `${count} ${count === 1 ? "lease" : "leases"}`;
}

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    version: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(USAGE);
    return 0;
  }
  const version = typeof values.version === "string" ? values.version : undefined;
  if (version !== undefined && !updateRequestedVersionSchema.safeParse(version).success) {
    throw new UsageError("--version takes a version, e.g. 0.4.0");
  }
  const json = values.json === true;
  const say = (line: string): void => {
    if (!json) environment.stdout.write(`${line}\n`);
  };
  const stopFollowing = (): number => {
    say("Stopped following. The update goes on; run simlock status to see it.");
    return 0;
  };
  let client = await connectDaemonClient(environment, token);
  const termination = waitForTermination(environment.signals);
  let stopped = false;
  void termination.settled.then(() => {
    stopped = true;
  });
  const pause = async (): Promise<void> => {
    await Promise.race([environment.sleep(POLL_MS), termination.settled]);
  };
  try {
    let current = await client.updateDaemon({
      ...(version === undefined ? {} : { version }),
      ...(values.force === true ? { force: true } : {}),
    });
    if (current.upToDate) {
      if (json) writeResult((value) => environment.stdout.write(value), current);
      else say(upToDateMessage(current, version));
      return 0;
    }
    const tracking = current.update ?? undefined;
    if (tracking !== undefined) say(`Updating simlock ${tracking.from} → ${tracking.to}`);
    let lastAnswerAt = environment.clock.now();
    let shown = "";
    const show = (update: UpdateState): void => {
      const key = update.stage === "waiting" ? `waiting ${update.leases}` : update.stage;
      if (key === shown) return;
      say(progressLine(update, shown === ""));
      shown = key;
    };
    while (current.update !== null) {
      show(current.update);
      await pause();
      if (stopped) return stopFollowing();
      try {
        current = await client.updateDaemon({ query: true });
        lastAnswerAt = environment.clock.now();
      } catch (error: unknown) {
        if (isSimlockError(error) && error.kind !== "transport") throw error;
        await client.close().catch(() => undefined);
        if (shown !== "restarting") say("Restarting the daemon");
        shown = "restarting";
        for (;;) {
          await pause();
          if (stopped) return stopFollowing();
          try {
            client = await connectDaemonClient(environment, token, { launch: false });
            current = await client.updateDaemon({ query: true });
            lastAnswerAt = environment.clock.now();
            break;
          } catch {
            if (environment.clock.now() - lastAnswerAt >= COME_BACK_MS) {
              say("The daemon did not come back; run simlock status.");
              return 1;
            }
          }
        }
      }
    }
    return finish(current, tracking, json, environment);
  } finally {
    termination.dispose();
    await client.close().catch(() => undefined);
  }
}

function upToDateMessage(answer: Answer, version: string | undefined): string {
  if (version !== undefined) return `simlock ${answer.version} is already running`;
  if (answer.resolved === answer.version) return `simlock ${answer.version} is already the latest`;
  return `simlock ${answer.version} is newer than the latest (${answer.resolved}). Use --version to install another version.`;
}

function progressLine(update: UpdateState, first: boolean): string {
  if (update.stage === "installing") return `Installing simlock@${update.to}`;
  if (update.stage === "restarting") return "Restarting the daemon";
  const base = `Waiting for ${plural(update.leases)} to end.`;
  return first ? `${base} Ctrl-C stops following; simlock update --force stops waiting.` : base;
}

function finish(
  answer: Answer,
  tracking: UpdateState | undefined,
  json: boolean,
  environment: CommandContext["environment"],
): number {
  const failure = answer.lastUpdateFailure;
  const failed =
    failure !== null &&
    tracking !== undefined &&
    failure.from === tracking.from &&
    failure.to === tracking.to;
  if (json) {
    writeResult((value) => environment.stdout.write(value), answer);
  } else if (failed) {
    environment.stdout.write(
      failure.stage === "installing"
        ? `Update failed (installing): ${failure.message}\nsimlock ${failure.from} is still running and takes leases again.\n`
        : `Update failed (restarting): ${failure.message}. Rolled back to ${failure.from}.\n`,
    );
  } else {
    environment.stdout.write(`simlock ${answer.version} is running\n`);
  }
  return failed ? 1 : 0;
}

export { run };
