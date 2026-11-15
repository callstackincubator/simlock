import { mobile } from "@e2e-dev/mobile";

import { simlockDevices } from "./index.js";

// why: this file is only type-checked (`pnpm typecheck`): a config that passes the provider as the
// `device` of `mobile()` must keep compiling against the runner's own types, with every option
// and with only the four required ones. It is left out of the build and of the tarball.
export const allOptions: unknown = mobile({
  platform: "ios",
  device: simlockDevices({
    url: "https://farm.example.com",
    token: "agent-token",
    platform: "ios",
    device: "iPhone 17 Pro",
    osVersion: "26.0",
    imageTag: "stable",
    deviceMode: "slim",
    deviceBaseline: "clean",
    extraApps: ["./build/helper.app"],
    ttlMs: 180_000,
    queueMs: 1_200_000,
    installConcurrency: 3,
  }),
});

export const requiredOnly: unknown = mobile({
  platform: "android",
  device: simlockDevices({
    url: "https://farm.example.com",
    token: "agent-token",
    platform: "android",
    device: "Pixel 9",
  }),
});
