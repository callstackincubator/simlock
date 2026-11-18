import { describe, expect, it } from "vitest";

import { fakeWorkerContext } from "../modules/testing.js";
import { ScriptedProcessRunner, type ScriptedProcessExpectation } from "../ports/index.js";
import { fseventsdModule } from "./index.js";

const PGREP = { args: ["-x", "fseventsd"], command: "pgrep" };
const TOP = { args: ["-l", "1", "-pid", "355", "-stats", "mem"], command: "top" };

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
  const loaded = await fseventsdModule.loadWorker();
  const worker = loaded.createWorker({ ...ctx, hostPlatform: "darwin", processRunner });
  return { processRunner, worker };
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
    }

    const again = await macWorker([pgrepFound, topPrints("28G"), pgrepFound, topPrints("14M")]);
    expect(await messagesOf(again.worker)).toHaveLength(1);
    expect(await messagesOf(again.worker)).toHaveLength(0);
  });
});
