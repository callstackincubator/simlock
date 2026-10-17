// why: `--since` without `--follow` never launches a daemon -- with none running the event file
// is read here instead, through the bus's own reader, loaded only for that path.
import { parseDuration } from "../duration.js";
import { asDaemonRefusal } from "../errors.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, writeResult } from "../args.js";
import { waitForTermination } from "../termination.js";
import type { EventPush, SimlockAdminClient } from "../../admin/index.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    follow: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    since: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock events [--follow] [--since <duration>]\n");
    return 0;
  }
  const sinceTs =
    typeof values.since === "string"
      ? environment.clock.now() - parseDuration(values.since)
      : undefined;
  const follow = values.follow === true;
  const client = await connectForEvents(environment, token, follow ? undefined : sinceTs);
  if (client === undefined) return 0;
  const replayInput = sinceTs === undefined ? {} : { sinceTs };
  try {
    if (follow) {
      await followEvents(client, replayInput, environment);
    } else {
      for (const event of await client.replayEvents(replayInput))
        writeResult((value) => environment.stdout.write(value), event);
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function connectForEvents(
  environment: CommandContext["environment"],
  token: string | undefined,
  historySinceTs: number | undefined,
): Promise<SimlockAdminClient | undefined> {
  if (historySinceTs === undefined) return connectDaemonClient(environment, token);
  try {
    return await connectDaemonClient(environment, token, { launch: false });
  } catch (error: unknown) {
    if ((await asDaemonRefusal(error)) !== undefined) throw error;
    for (const event of await environment.readEventFile(historySinceTs))
      writeResult((value) => environment.stdout.write(value), event);
    return undefined;
  }
}

async function followEvents(
  client: SimlockAdminClient,
  replayInput: { readonly sinceTs?: number },
  environment: CommandContext["environment"],
): Promise<void> {
  const { eventKey } = await import("../../bus/index.js");
  let buffered: EventPush[] | undefined = [];
  const unsubscribe = await client.subscribeEvents((event) => {
    if (buffered === undefined) writeResult((value) => environment.stdout.write(value), event);
    else buffered.push(event);
  });
  const replayed = await client.replayEvents(replayInput);
  for (const event of replayed) writeResult((value) => environment.stdout.write(value), event);
  const printed = new Set(replayed.map(eventKey));
  const pending = buffered;
  buffered = undefined;
  for (const push of pending) {
    if (!printed.has(eventKey(push.event)))
      writeResult((value) => environment.stdout.write(value), push);
  }
  await waitForTermination(environment.signals).settled;
  await unsubscribe();
}

export { run };
