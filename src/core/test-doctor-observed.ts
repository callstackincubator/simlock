export function driverDevice(deviceId: string) {
  return {
    physical: false,
    address: `${deviceId}-address`,
    deviceId,
    driverData: { fakeDeviceId: deviceId },
  };
}

export function observed(deviceId: string, runState: "running" | "stopped") {
  return { ...driverDevice(deviceId), runState };
}
