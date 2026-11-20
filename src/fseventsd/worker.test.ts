import { describe, expect, it } from "vitest";

import { fakeWorkerContext } from "../modules/testing.js";
import {
  NoopLogger,
  ScriptedProcessRunner,
  type Logger,
  type ScriptedProcessExpectation,
} from "../ports/index.js";
import { fseventsdModule } from "./index.js";

const PGREP = { args: ["-x", "fseventsd"], command: "/usr/bin/pgrep" };
const TOP = { args: ["-l", "1", "-pid", "355", "-stats", "mem"], command: "/usr/bin/top" };

const pgrepFound: ScriptedProcessExpectation = {
  match: PGREP,
  result: { code: 0, stderr: "", stdout: "355\n" },
};
const pgrepNone: ScriptedProcessExpectation = {
  match: PGREP,
  result: { code: 1, stderr: "", stdout: "" },
};
const topPrints = (figure: string): ScriptedProcessExpectation => ({
  match: TOP,
  result: { code: 0, stderr: "", stdout: `Processes: 400 total\n${figure}\n` },
});

async function macWorker(script: readonly ScriptedProcessExpectation[]) {
  const { ctx } = await fakeWorkerContext("fseventsd", {});
  const processRunner = new ScriptedProcessRunner(script);
  const warnings: string[] = [];
  const logger: Logger = new (class extends NoopLogger {
    override warn(message: string): void {
      warnings.push(message);
    }
  })();
  const loaded = await fseventsdModule.loadWorker();
  const worker = loaded.createWorker({ ...ctx, hostPlatform: "darwin", logger, processRunner });
  return { processRunner, warnings, worker };
}

const messagesOf = async (worker: Awaited<ReturnType<typeof macWorker>>["worker"]) =>
  (await worker.findings?.())?.map((finding) => finding.message) ?? [];

describe("fseventsd module", () => {
  it("reads fseventsd's memory when findings are read, warns over 2 GB, and reads again on the next run", async () => {
    const readings: readonly [
      script: readonly ScriptedProcessExpectation[],
      expected: readonly string[],
    ][] = [
      [[pgrepFound, topPrints("28G")], ["28.0 GB"]],
      [[pgrepFound, topPrints("2049M")], ["2.0 GB"]],
      [[pgrepFound, topPrints("2048M")], []],
      [[pgrepFound, topPrints("1.5G")], []],
      [[pgrepFound, topPrints("2100M+")], ["2.1 GB"]],
      [[pgrepNone], []],
    ];
    for (const [script, expected] of readings) {
      const { processRunner, worker } = await macWorker(script);
      expect(processRunner.calls).toEqual([]);
      const messages = await messagesOf(worker);
      expect(messages.map((message) => /\d+\.\d GB/.exec(message)?.[0])).toEqual(expected);
      expect(processRunner.calls.map((call) => call.options.timeoutMs)).toEqual(
        script.map(() => 5_000),
      );
    }

    const { worker: texts } = await macWorker([pgrepFound, topPrints("3221225472B")]);
    const found = (await texts.findings?.()) ?? [];
    expect(found).toEqual([
      {
        advisory: true,
        message:
          "fseventsd uses 3.0 GB of memory, over the 2 GB limit. macOS keeps file-change records there, and lease churn can grow it until the Mac swaps.",
        remedy:
          'Restart it with `sudo killall fseventsd` (macOS starts it again at once). To restart it every hour, see "fseventsd uses too much memory" in the worker troubleshooting docs.',
      },
    ]);

    const again = await macWorker([pgrepFound, topPrints("28G"), pgrepFound, topPrints("14M")]);
    expect(await messagesOf(again.worker)).toHaveLength(1);
    expect(await messagesOf(again.worker)).toHaveLength(0);
  });

  it("adds no finding for a failed reading and logs one warning per run", async () => {
    const timedOut = { code: null, endedBy: "timeout", stderr: "", stdout: "" } as const;
    const failures: readonly [script: readonly ScriptedProcessExpectation[], reason: string][] = [
      [[pgrepFound, { match: TOP, result: { code: 1, stderr: "", stdout: "" } }], "top exited 1"],
      [[pgrepFound, topPrints("n/a")], 'unexpected output "n/a"'],
      [[pgrepFound, { match: TOP, result: timedOut }], "top timed out after 5 s"],
      [[{ match: PGREP, result: timedOut }], "pgrep timed out after 5 s"],
      [[{ match: PGREP, result: { code: 2, stderr: "", stdout: "" } }], "pgrep exited 2"],
      [[{ match: PGREP, result: { code: 0, stderr: "", stdout: "\n" } }], 'unexpected output ""'],
      [
        [pgrepFound, topPrints(`\u001b[31m${"x".repeat(100)}`)],
        `unexpected output "\\u001b[31m${"x".repeat(75)}"`,
      ],
    ];
    for (const [script, reason] of failures) {
      const { warnings, worker } = await macWorker(script);
      expect(await messagesOf(worker)).toEqual([]);
      expect(warnings).toEqual([`Could not read fseventsd's memory: ${reason}`]);
    }

    const quiet = await macWorker([pgrepNone]);
    await messagesOf(quiet.worker);
    expect(quiet.warnings).toEqual([]);
  });
});
