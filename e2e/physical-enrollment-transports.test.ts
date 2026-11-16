import { describe, expect, it } from "vitest";

import { type TestEnv, waitFor, withDaemon, withHttpDaemon } from "./helpers/index.js";
import {
  IOS_BASE,
  IPHONE,
  Row,
  UDID,
  add,
  bearer,
  httpDaemon,
  inspectCalls,
  rows,
} from "./test-physical-enrollment.js";

describe("device add over HTTP", () => {
  it("POST /v1/devices with an operator token enrols the device; with an agent token it is 403 FORBIDDEN and no inspectPhysical call is made; a body with a worker field or any other unknown field is 400 BAD_REQUEST", async () => {
    const { base, env } = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });
    const agent = await bearer(env, "agent");
    const operator = await bearer(env, "operator");
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${base}/v1/devices`, { body: JSON.stringify(body), headers, method: "POST" });

    const refused = await post(agent, { id: UDID, platform: "ios" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(await inspectCalls(env)).toEqual([]);

    for (const extra of [{ worker: "w1" }, { nickname: "mine" }]) {
      const bad = await post(operator, { id: UDID, platform: "ios", ...extra });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    }
    expect(await inspectCalls(env)).toEqual([]);

    const accepted = await post(operator, { id: UDID, platform: "ios" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      appCount: 12,
      driverDeviceId: UDID,
      reenrolled: false,
    });
    expect((await rows(env)).filter((row) => row.state === "ready")).toHaveLength(1);
  });

  it("DELETE /v1/devices/<canonical ID> with an operator token unenrols the device; with an agent token it is 403 FORBIDDEN and the record stays ready", async () => {
    const { base, env } = await httpDaemon({ ios: { physicalDevices: [IPHONE] } });
    const enrolled = await add(env, "ios", UDID);
    const agent = await bearer(env, "agent");
    const operator = await bearer(env, "operator");
    const remove = (headers: Record<string, string>) =>
      fetch(`${base}/v1/devices/${encodeURIComponent(UDID)}`, { headers, method: "DELETE" });

    const refused = await remove(agent);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect((await rows(env)).find((row) => row.id === enrolled.id)?.state).toBe("ready");

    const accepted = await remove(operator);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ driverDeviceId: UDID, id: enrolled.id });
    expect((await rows(env)).find((row) => row.id === enrolled.id)?.state).toBe("deleted");
  });
});

describe("device add through a gateway", () => {
  async function fleet(): Promise<{ gateway: TestEnv; worker: TestEnv; workerId: string }> {
    const { env: gateway, port } = await withHttpDaemon((port) => ({
      configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
      role: "gateway",
      driver: "none",
    }));
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code, minted.stderr).toBe(0);
    const { secret } = minted.json as { secret: string };
    const worker = await withDaemon({
      configOverrides: { gateway: { label: "w1", token: secret, url: `ws://127.0.0.1:${port}` } },
      driverScript: { ios: { ...IOS_BASE, physicalDevices: [IPHONE] } },
    });
    let workerId = "";
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const workers = (listed.json as { workers?: { id: string; connection: string }[] } | null)
          ?.workers;
        const connected = workers?.find((entry) => entry.connection === "connected");
        workerId = connected?.id ?? "";
        return connected !== undefined;
      },
      { label: "the worker is connected to the gateway" },
    );
    return { gateway, worker, workerId };
  }

  it("shows a device enrolled on worker w1's own daemon in the gateway's list --devices on w1 with its driverDeviceId", async () => {
    const { gateway, worker, workerId } = await fleet();

    const added = await worker.cli(["device", "add", "--platform", "ios", UDID]);
    expect(added.code, added.stderr).toBe(0);

    await waitFor(
      async () => {
        const listed = await gateway.cli(["list", "--devices"]);
        const device = (listed.json as Row[] | null)?.find((row) => row.physical);
        return device?.workerId === workerId && device.driverDeviceId === UDID;
      },
      { label: "the gateway lists the enrolled device on w1" },
    );
  });

  it("answers device add and device remove with UNSUPPORTED_IN_GATEWAY_MODE and exit 2, saying to run the command on the worker the device is plugged into, and no worker's driver log has an inspectPhysical call", async () => {
    const { gateway, worker } = await fleet();
    await worker.driverLog.clear();

    const added = await gateway.cli(["device", "add", "--platform", "ios", UDID]);
    const removed = await gateway.cli(["device", "remove", UDID]);

    for (const result of [added, removed]) {
      expect(result.code, result.stderr).toBe(2);
      expect(result.error?.code).toBe("UNSUPPORTED_IN_GATEWAY_MODE");
      expect(result.error?.message).toContain("worker the device is plugged into");
    }
    expect(await inspectCalls(worker)).toEqual([]);
  });
});
