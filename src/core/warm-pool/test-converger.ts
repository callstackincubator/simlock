import type { VirtualDevice } from "../domain.js";
import type { WarmTarget } from "./config.js";

export const iphone17: WarmTarget = {
  count: 1,
  model: "iPhone 17",
  osVersion: "26.0",
  platform: "ios",
};
export const kind = {
  model: "iPhone 17",
  osVersion: "26.0",
  physical: false,
  platform: "ios",
} as const;
export const ofKind = (
  id: string,
  state: VirtualDevice["state"],
  createdAt = 1,
): VirtualDevice => ({
  physical: false,
  createdAt,
  driverData: {},
  driverDeviceId: `driver-${id}`,
  id,
  mode: "full",
  spec: kind,
  state,
});
export function held() {
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const gate = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { fail, finish, gate };
}
export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};
