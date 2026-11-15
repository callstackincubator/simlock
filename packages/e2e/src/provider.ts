import { randomBytes } from "node:crypto";

import type { DeviceLease, DeviceProvider, DeviceRequest } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";

import type { ProviderOptions } from "./options.js";
import { DeviceSetupFailed, installApp, limiter, type Installation } from "./install.js";
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

  async function leaseOnce(request: DeviceRequest, attempt: number): Promise<DeviceLease> {
    const session = `e2e-${request.runId.slice(0, 12)}-${String(request.slot)}${attempt === 0 ? "" : `-r${String(attempt)}`}`;
    const started = Date.now();
    const clientId = randomBytes(8).toString("hex");
    const farm = await client(session);
    const scope = (leaseId: string, id = clientId) => ({
      tenant: TENANT,
      runId: request.runId,
      leaseId,
      clientId: id,
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
    try {
      const deviceId = lease.deviceKey?.split(":").pop();
      if (lease.deviceKey === undefined || deviceId === undefined || deviceId === "") {
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
      const on: Installation = {
        apps: (await client(session, granted.client as ClientConfig)).apps,
        platform: options.platform,
        deviceId,
        limit: withinLimit,
        signal: request.signal,
        log: request.log,
      };
      if (request.appPath !== undefined) await installApp(on, request.appPath, request.app);
      for (const extra of options.extraApps) await installApp(on, extra, undefined);
      return request.appPath !== undefined && request.app !== undefined
        ? { ...granted, installedApp: request.app }
        : granted;
    } catch (error) {
      await farm.leases
        .release(scope(lease.leaseId, lease.clientId ?? clientId))
        .catch(() => undefined);
      throw error;
    }
  }

  async function acquire(request: DeviceRequest): Promise<DeviceLease> {
    if (request.platform !== options.platform) {
      throw new Error(
        `simlockDevices leases ${options.platform} devices; the target asked for ${request.platform}`,
      );
    }
    try {
      return await leaseOnce(request, 0);
    } catch (first) {
      if (!(first instanceof DeviceSetupFailed)) throw first;
      request.log(
        `simlock: install on ${first.deviceId} failed (${first.message}); leasing another device`,
      );
      try {
        return await leaseOnce(request, 1);
      } catch (second) {
        if (!(second instanceof DeviceSetupFailed)) throw second;
        throw new Error(`simlock: could not set up a device after 2 tries: ${second.message}`, {
          cause: second,
        });
      }
    }
  }

  // why: release comes with the provider's release task; the factory is what this one ships.
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error("simlock: not implemented"));
  return { name: "simlock", acquire, release: notImplemented };
}
