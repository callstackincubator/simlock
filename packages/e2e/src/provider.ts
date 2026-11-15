import { randomBytes } from "node:crypto";

import type { DeviceLease, DeviceProvider, DeviceRequest } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";

import type { ProviderOptions } from "./options.js";
import { limiter, sendAgain } from "./install.js";
import { allocateQueued } from "./queue.js";

type AgentDeviceClientFactory = typeof createAgentDeviceClient;
type Client = ReturnType<AgentDeviceClientFactory>;
type ClientConfig = NonNullable<Parameters<AgentDeviceClientFactory>[0]>;

// why: the agent-device client wants a tenant; simlock overwrites it with one made from the token and the lease.
const TENANT = "simlock-e2e";

export function createProvider(
  options: ProviderOptions,
  loadClient: () => Promise<AgentDeviceClientFactory>,
): DeviceProvider {
  const daemonBaseUrl = `${options.url}/v1/agent-device`;
  const leaseBackend = `${options.platform}-instance` as const;
  const withinLimit = limiter(options.installConcurrency);

  const client = async (session: string, scope?: ClientConfig): Promise<Client> => {
    let factory: AgentDeviceClientFactory;
    try {
      factory = await loadClient();
    } catch {
      throw new Error("simlock: the agent-device package is not installed; add it to your project");
    }
    return factory({ daemonBaseUrl, daemonAuthToken: options.token, session, ...scope });
  };

  async function acquire(request: DeviceRequest): Promise<DeviceLease> {
    if (request.platform !== options.platform) {
      throw new Error(
        `simlockDevices leases ${options.platform} devices; the target asked for ${request.platform}`,
      );
    }
    const session = `e2e-${request.runId.slice(0, 12)}-${request.slot}`;
    const started = Date.now();
    const clientId = randomBytes(8).toString("hex");
    const farm = await client(session);
    const scope = (leaseId: string) => ({
      tenant: TENANT,
      runId: request.runId,
      leaseId,
      clientId,
      leaseBackend,
      leaseProvider: "proxy" as const,
    });
    const lease = await allocateQueued({
      platform: options.platform,
      queueMs: options.queueMs,
      signal: request.signal,
      log: request.log,
      release: (leaseId) => farm.leases.release(scope(leaseId)),
      allocate: (leaseId, signal) =>
        farm.leases.allocate({
          ...scope(leaseId),
          platform: options.platform,
          target: "mobile",
          device: options.device,
          ttlMs: options.ttlMs,
          retainOnClose: true,
          signal,
          ...(options.osVersion === undefined ? {} : { osVersion: options.osVersion }),
          ...(options.imageTag === undefined ? {} : { imageTag: options.imageTag }),
          ...(options.deviceMode === undefined ? {} : { deviceMode: options.deviceMode }),
          ...(options.deviceBaseline === undefined
            ? {}
            : { deviceBaseline: options.deviceBaseline }),
        }),
    });
    const deviceId = lease.deviceKey?.split(":").pop();
    if (lease.deviceKey === undefined || deviceId === undefined || deviceId === "") {
      await farm.leases.release({ ...scope(lease.leaseId), clientId: lease.clientId ?? clientId });
      throw new Error(`simlock: lease ${lease.leaseId} names no device`);
    }
    request.log(
      `simlock: lease ${lease.leaseId} granted in ${String(Date.now() - started)} ms (${options.device} ${deviceId})`,
    );
    const granted: DeviceLease = {
      id: lease.leaseId,
      daemon: { baseUrl: daemonBaseUrl, authToken: options.token },
      client: {
        tenant: lease.tenantId,
        runId: request.runId,
        leaseId: lease.leaseId,
        leaseBackend: lease.backend,
        leaseProvider: "proxy",
        clientId: lease.clientId ?? clientId,
        deviceKey: lease.deviceKey,
      },
      deviceId,
    };
    const selection = options.platform === "android" ? { serial: deviceId } : { udid: deviceId };
    const scoped = await client(session, granted.client as ClientConfig);
    const install = async (appPath: string, app?: string): Promise<void> => {
      request.signal.throwIfAborted();
      const installing = Date.now();
      await sendAgain(
        () =>
          withinLimit(() =>
            scoped.apps.install({
              platform: options.platform,
              ...selection,
              appPath,
              ...(app === undefined ? {} : { app }),
            }),
          ),
        request.signal,
      );
      request.log(`simlock: installed ${app ?? appPath} in ${String(Date.now() - installing)} ms`);
    };
    if (request.appPath !== undefined) await install(request.appPath, request.app);
    for (const extra of options.extraApps) await install(extra);
    return request.appPath !== undefined && request.app !== undefined
      ? { ...granted, installedApp: request.app }
      : granted;
  }

  // why: release comes with the provider's release task; the factory is what this one ships.
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error("simlock: not implemented"));
  return { name: "simlock", acquire, release: notImplemented };
}
