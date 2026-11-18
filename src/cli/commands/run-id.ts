import { RUN_ID_PATTERN } from "../../contract/index.js";
import { UsageError } from "../args.js";

/** why: `--run` and `SIMLOCK_RUN` are held to the daemon's run id rule before anything is sent, so a bad one fails the step at once. */
export function checkedRunId(value: string, source: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new UsageError(
      `${source} takes a run id: 1 to 128 letters, digits, \`.\`, \`_\` or \`-\``,
    );
  }
  return value;
}
