import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

describe("CLI: release --run", () => {
  async function release(
    argv: string[],
    answer: () => Promise<{ leaseIds: string[]; requestIds: string[] }>,
  ) {
    const output = outputCapture();
    const sent: string[] = [];
    let connected = false;
    let confirmed = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        confirm: async () => {
          confirmed = true;
          return true;
        },
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            releaseRunLeases: (input) => {
              sent.push(input.runId);
              return answer();
            },
          });
        },
      }),
    );
    return { code, confirmed, connected, sent, stderr: output.stderr, stdout: output.stdout };
  }

  const answers = () => Promise.resolve({ leaseIds: ["lse_1", "lse_2"], requestIds: ["req_1"] });
  const nothing = () => Promise.resolve({ leaseIds: [], requestIds: [] });
  const usage = (message: string) => ({ error: { code: "USAGE", message } });

  it("prints what a run release freed with no confirmation, fails before sending on a bad id or a mix with a lease id or --all, and relays a refusal", async () => {
    const freed = await release(["release", "--run", "nightly-7"], answers);
    expect(freed).toMatchObject({ code: 0, confirmed: false, sent: ["nightly-7"] });
    expect(JSON.parse(freed.stdout)).toEqual({
      leaseIds: ["lse_1", "lse_2"],
      requestIds: ["req_1"],
    });

    const empty = await release(["release", "--run", "nightly-7"], nothing);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ leaseIds: [], requestIds: [] });

    const refused = [
      [
        ["release", "--run", "run 1"],
        "--run takes a run id: 1 to 128 letters, digits, `.`, `_` or `-`",
      ],
      [
        ["release", "lse_1", "--run", "nightly-7"],
        "release accepts a lease id, --all or --run <id>, only one of them",
      ],
      [
        ["release", "--all", "--yes", "--run", "nightly-7"],
        "release accepts a lease id, --all or --run <id>, only one of them",
      ],
    ] as const;
    for (const [argv, message] of refused) {
      const result = await release([...argv], answers);
      expect(result).toMatchObject({ code: 2, sent: [] });
      expect(JSON.parse(result.stderr)).toEqual(usage(message));
    }

    for (const code of ["FORBIDDEN", "WORKER_UNREACHABLE"] as const) {
      const result = await release(["release", "--run", "nightly-7"], () =>
        Promise.reject(new SimlockError(code, "protocol", `${code} from the farm`, {})),
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code, message: `${code} from the farm` },
      });
    }
  });
});
