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
type Environment = CommandContext["environment"];

interface Followed {
  readonly answer: Answer;
  readonly interrupted?: true;
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "lease" : "leases"}`;
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

class Follower {
  #client: SimlockAdminClient;
  #stopped = false;
  #shown = "";
  #lastAnswerAt: number;

  constructor(
    client: SimlockAdminClient,
    private readonly environment: Environment,
    private readonly token: string | undefined,
    private readonly say: (line: string) => void,
    private readonly termination: ReturnType<typeof waitForTermination>,
  ) {
    this.#client = client;
    this.#lastAnswerAt = environment.clock.now();
    void termination.settled.then(() => {
      this.#stopped = true;
    });
  }

  async follow(first: Answer): Promise<Followed> {
    if (first.update !== null)
      this.say(`Updating simlock ${first.update.from} → ${first.update.to}`);
    let current: Answer | undefined = first;
    while (current?.update != null) {
      this.#show(current.update);
      await this.#pause();
      current = this.#stopped ? undefined : await this.#poll();
    }
    return current === undefined ? { answer: first, interrupted: true } : { answer: current };
  }

  close(): Promise<void> {
    return this.#client.close().catch(() => undefined);
  }

  #show(update: UpdateState): void {
    const key = update.stage === "waiting" ? `waiting ${update.leases}` : update.stage;
    if (key === this.#shown) return;
    this.say(progressLine(update, this.#shown === ""));
    this.#shown = key;
  }

  async #pause(): Promise<void> {
    await Promise.race([this.environment.sleep(POLL_MS), this.termination.settled]);
  }

  async #poll(): Promise<Answer | undefined> {
    try {
      const answer = await this.#client.updateDaemon({ query: true });
      this.#lastAnswerAt = this.environment.clock.now();
      return this.#stopped ? undefined : answer;
    } catch (error: unknown) {
      if (isSimlockError(error) && error.kind !== "transport") throw error;
      await this.close();
      if (this.#shown !== "restarting") this.say("Restarting the daemon");
      this.#shown = "restarting";
      return this.#reconnect();
    }
  }

  async #reconnect(): Promise<Answer | undefined> {
    for (;;) {
      await this.#pause();
      if (this.#stopped) return undefined;
      try {
        // why: each pass opens its own connection, so the one before it is closed first and none outlives the command.
        await this.close();
        this.#client = await connectDaemonClient(this.environment, this.token, { launch: false });
        const answer = await this.#client.updateDaemon({ query: true });
        this.#lastAnswerAt = this.environment.clock.now();
        // why: a daemon still starting answers a query too, but its update result is not read yet, so only a running one has the last word.
        if (answer.health === "running") return answer;
      } catch {
        if (this.environment.clock.now() - this.#lastAnswerAt >= COME_BACK_MS) throw new GaveUp();
      }
    }
  }
}

class GaveUp extends Error {}

function parseUpdateArgs(argv: readonly string[]) {
  const values = commandArgs(argv, {
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    version: { type: "string" },
  });
  const version = typeof values.version === "string" ? values.version : undefined;
  if (version !== undefined && !updateRequestedVersionSchema.safeParse(version).success) {
    throw new UsageError("--version takes a version, e.g. 0.4.0");
  }
  return {
    help: values.help === true,
    json: values.json === true,
    request: {
      ...(version === undefined ? {} : { version }),
      ...(values.force === true ? { force: true } : {}),
    },
    version,
  };
}

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const args = parseUpdateArgs(argv);
  if (args.help) {
    environment.stdout.write(USAGE);
    return 0;
  }
  const say = (line: string): void => {
    if (!args.json) environment.stdout.write(`${line}\n`);
  };
  const client = await connectDaemonClient(environment, token);
  const termination = waitForTermination(environment.signals);
  const follower = new Follower(client, environment, token, say, termination);
  try {
    const first = await client.updateDaemon(args.request);
    if (first.upToDate) {
      if (args.json) writeResult((value) => environment.stdout.write(value), first);
      else say(upToDateMessage(first, args.version));
      return 0;
    }
    return await finish(await follower.follow(first), environment, say, args.json);
  } catch (error: unknown) {
    if (!(error instanceof GaveUp)) throw error;
    say("The daemon did not come back; run simlock status.");
    return 1;
  } finally {
    termination.dispose();
    await follower.close();
  }
}

function finish(
  followed: Followed,
  environment: Environment,
  say: (line: string) => void,
  json: boolean,
): number {
  const { answer } = followed;
  if (followed.interrupted === true) {
    say("Stopped following. The update goes on; run simlock status to see it.");
    return 0;
  }
  const failure = answer.lastUpdateFailure;
  const failed = failure !== null;
  if (json) {
    writeResult((value) => environment.stdout.write(value), answer);
  } else if (failed) {
    say(
      failure.stage === "installing"
        ? `Update failed (installing): ${failure.message}\nsimlock ${failure.from} is still running and takes leases again.`
        : `Update failed (restarting): ${failure.message}. Rolled back to ${failure.from}.`,
    );
  } else {
    say(`simlock ${answer.version} is running`);
  }
  return failed ? 1 : 0;
}

export { run };
