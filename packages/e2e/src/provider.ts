import { randomBytes } from "node:crypto";

import type { DeviceLease, DeviceProvider, DeviceRequest } from "@e2e-dev/mobile";
import type { createAgentDeviceClient } from "agent-device";

import type { ProviderOptions } from "./options.js";

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
    const leaseId = randomBytes(16).toString("hex");
    const clientId = randomBytes(8).toString("hex");
    const farm = await client(session);
    const lease = await farm.leases.allocate({
      tenant: TENANT,
      runId: request.runId,
      leaseId,
      clientId,
      leaseBackend,
      leaseProvider: "proxy",
      platform: options.platform,
      target: "mobile",
      device: options.device,
      ttlMs: options.ttlMs,
      retainOnClose: true,
      ...(options.osVersion === undefined ? {} : { osVersion: options.osVersion }),
      ...(options.imageTag === undefined ? {} : { imageTag: options.imageTag }),
      ...(options.deviceMode === undefined ? {} : { deviceMode: options.deviceMode }),
      ...(options.deviceBaseline === undefined ? {} : { deviceBaseline: options.deviceBaseline }),
    });
    const deviceId = lease.deviceKey?.split(":").pop();
    if (lease.deviceKey === undefined || deviceId === undefined || deviceId === "") {
      await farm.leases.release({
        tenant: TENANT,
        runId: request.runId,
        leaseId: lease.leaseId,
        leaseBackend,
        leaseProvider: "proxy",
        clientId: lease.clientId ?? clientId,
      });
      throw new Error(`simlock: lease ${lease.leaseId} names no device`);
    }
    request.log(
      `simlock: lease ${lease.leaseId} granted in ${String(Date.now() - started)} ms (${options.device} ${deviceId})`,
    );
    return {
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
  }

  // why: release comes with the provider's release task; the factory is what this one ships.
  const notImplemented = (): Promise<never> =>
    Promise.reject(new Error("simlock: not implemented"));
  return { name: "simlock", acquire, release: notImplemented };
}
