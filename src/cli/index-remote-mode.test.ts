import { describe, expect, it, vi } from "vitest";
import { WebSocketRefusedError } from "../ports/index.js";
import { runCli } from "./index.js";
import { EMPTY_STATUS, fakeClient, outputCapture } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

interface Setup {
  readonly url?: string;
  readonly token?: string;
  readonly adminToken?: string;
}

function session(setup: Setup = {}, farm = new FakeFarm({ "status.get": () => EMPTY_STATUS })) {
  const output = outputCapture();
  const connectAdmin = vi.fn(async () => fakeClient());
  const connectExistingAdmin = vi.fn(async () => fakeClient());
  const environment = output.environmentWith({
    connectAdmin,
    connectExistingAdmin,
    webSocket: farm,
    ...(setup.url === undefined ? {} : { tunnelUrl: setup.url }),
    ...(setup.token === undefined ? {} : { tunnelToken: setup.token }),
    ...(setup.adminToken === undefined ? {} : { adminTokenFromEnv: setup.adminToken }),
  });
  const run = (argv: readonly string[]) => runCli(argv, environment);
  const launched = () => connectAdmin.mock.calls.length + connectExistingAdmin.mock.calls.length;
  return { farm, launched, output, run };
}

describe("CLI: remote mode selection", () => {
  it("runs a command on the farm when --url or SIMLOCK_URL is set with a token, and on this machine's daemon otherwise; sends --token over SIMLOCK_TOKEN and never SIMLOCK_ADMIN_TOKEN; a refused token fails UNAUTHENTICATED; nothing is launched remotely", async () => {
    const accepted: [string, string][] = [
      ["https://farm.example.com", "wss://farm.example.com/v1/session"],
      ["https://farm.example.com:8443", "wss://farm.example.com:8443/v1/session"],
      ["http://127.0.0.1:7801", "ws://127.0.0.1:7801/v1/session"],
      ["http://localhost:7801", "ws://localhost:7801/v1/session"],
      ["http://[::1]:7801", "ws://[::1]:7801/v1/session"],
    ];
    for (const [url, socket] of accepted) {
      for (const how of ["environment", "flag"] as const) {
        const { farm, launched, run } = session(
          how === "environment" ? { token: "slk_t", url } : { token: "slk_t" },
        );
        const argv = how === "flag" ? ["status", "--json", "--url", url] : ["status", "--json"];
        expect(await run(argv), `${how} ${url}`).toBe(0);
        expect(farm.connections.map(({ url: opened }) => opened)).toEqual([socket]);
        expect(farm.requestTypes()).toEqual(["status.get"]);
        expect(launched()).toBe(0);
      }
    }

    const refused: [string, string][] = [
      ["http://farm.example.com", "must be https://"],
      ["https://farm.example.com/simlock", "origin only"],
      ["https://farm.example.com/?x=1", "origin only"],
      ["https://farm.example.com/#a", "origin only"],
      ["farm.example.com", "must be https://"],
      ["ws://farm.example.com", "must be https://"],
    ];
    for (const [url, message] of refused) {
      const { farm, launched, output, run } = session({ token: "slk_t", url });
      expect(await run(["status"]), url).toBe(2);
      expect(output.stderr).toContain(message);
      expect(farm.connections, url).toHaveLength(0);
      expect(launched()).toBe(0);
    }

    const local: Setup[] = [{}, { url: "" }];
    for (const setup of local) {
      const { farm, launched, run } = session(setup);
      expect(await run(["status"])).toBe(0);
      expect(farm.connections).toHaveLength(0);
      expect(launched()).toBe(1);
    }
    const flagged = session({ token: "slk_t", url: "https://farm.example.com" });
    expect(await flagged.run(["status", "--local"])).toBe(0);
    expect(flagged.farm.connections).toHaveLength(0);
    expect(flagged.launched()).toBe(1);

    for (const flag of ["--local", "--gateway"]) {
      const { farm, launched, output, run } = session({ token: "slk_t" });
      expect(await run(["status", "--url", "https://farm.example.com", flag])).toBe(2);
      expect(output.stderr).toContain("--url cannot be used with --local or --gateway");
      expect(farm.connections).toHaveLength(0);
      expect(launched()).toBe(0);
    }

    const tokenless = session({ url: "https://farm.example.com" });
    expect(await tokenless.run(["status"])).toBe(2);
    expect(tokenless.output.stderr).toContain("No token: pass --token or set SIMLOCK_TOKEN");
    expect(tokenless.farm.connections).toHaveLength(0);

    const credentials = session({
      adminToken: "admin-secret",
      token: "from-environment",
      url: "https://farm.example.com",
    });
    expect(await credentials.run(["status", "--json", "--token", "from-flag"])).toBe(0);
    expect(await credentials.run(["status", "--json"])).toBe(0);
    expect(credentials.farm.connections.map(({ options }) => options.headers)).toEqual([
      { authorization: "Bearer from-flag" },
      { authorization: "Bearer from-environment" },
    ]);
    expect(JSON.stringify(credentials.farm.requests)).not.toContain("admin-secret");
    expect(credentials.launched()).toBe(0);

    const refusedFarm = new FakeFarm();
    refusedFarm.failure = new WebSocketRefusedError(401, "{}");
    const rejected = session({ token: "wrong", url: "https://farm.example.com" }, refusedFarm);
    expect(await rejected.run(["status"])).toBe(1);
    const lines = rejected.output.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message:
          "https://farm.example.com refused the token: create one with `simlock token create` on the worker or gateway",
      },
    });
    expect(rejected.launched()).toBe(0);
  });
});
