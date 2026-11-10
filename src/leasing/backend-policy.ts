import {
  BadDeviceRequestError,
  type DeviceRecord,
  type DeviceRequest,
  type Driver,
  type DriverCatalog,
  type LeaseRecord,
  type Platform,
  type VirtualDevice,
} from "../core/index.js";

interface BackendSnapshot {
  readonly devices: readonly DeviceRecord[];
  readonly virtualDevices: readonly VirtualDevice[];
  readonly leases: readonly LeaseRecord[];
}

interface BackendPolicyPorts {
  readonly registry: { readonly snapshot: BackendSnapshot };
  readonly drivers: Pick<DriverCatalog, "get">;
}

export function requireBackendCapabilities(driver: Driver, request: DeviceRequest): void {
  const capabilities = driver.backend.capabilities;
  if (request.baseline !== undefined && capabilities.baselines === false) {
    throw new BadDeviceRequestError("This backend does not support saved baselines");
  }
  if (request.except !== undefined && capabilities.except === false) {
    throw new BadDeviceRequestError("This backend does not support except");
  }
  if (request.physical === true && capabilities.physical === false) {
    throw new BadDeviceRequestError("This backend does not support physical devices");
  }
}

export function backendSnapshot(ports: BackendPolicyPorts, platform: Platform): BackendSnapshot {
  const snapshot = ports.registry.snapshot;
  const backend = ports.drivers.get(platform).backend.id;
  const devices = snapshot.devices.filter(
    (device) => device.spec.platform !== platform || device.backend === backend,
  );
  const virtualDevices = snapshot.virtualDevices.filter(
    (device) => device.spec.platform !== platform || device.backend === backend,
  );
  return { ...snapshot, devices, virtualDevices };
}
