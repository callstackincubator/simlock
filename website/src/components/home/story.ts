// why: routing reasons follow gateway.routing in docs/CONFIGURATION.md (warm device first, then
// the most free capacity), so the story never claims a placement Simlock would not make.

export const gatewayUrl = "https://gw.example";

export type Stage = "provisioning" | "booting";

export type Lane = {
  where: string;
  agent: string;
  platform: "ios" | "android";
  device: string;
  worker: { id: string; label: string; host: string; platforms: string };
  lease: string;
  why: string;
  stages: Stage[];
};

export const lanes: Lane[] = [
  {
    where: "laptop",
    agent: "agent-1",
    platform: "ios",
    device: "iPhone 17 Pro",
    worker: { id: "9b07de11", label: "mac-studio-1", host: "macOS", platforms: "iOS · Android" },
    lease: "9b07de11.lse_4a1d",
    why: "warm device",
    stages: [],
  },
  {
    where: "ci",
    agent: "agent-2",
    platform: "ios",
    device: "iPhone 17 Pro",
    worker: { id: "3f81a2c4", label: "mac-studio-2", host: "macOS", platforms: "iOS · Android" },
    lease: "3f81a2c4.lse_9f2c",
    why: "most free capacity",
    stages: ["provisioning", "booting"],
  },
  {
    where: "claude code",
    agent: "agent-3",
    platform: "android",
    device: "Pixel 8",
    worker: { id: "5c2e90b7", label: "linux-ci-1", host: "Linux", platforms: "Android" },
    lease: "5c2e90b7.lse_77b0",
    why: "most free capacity",
    stages: ["booting"],
  },
];

export const stageLabel =
  "Three agents send lease requests to one gateway URL. The gateway sends each to a different worker: mac-studio-1 grants a warm iPhone 17 Pro at once, mac-studio-2 provisions and boots one, and linux-ci-1 boots an Android Pixel 8. Each agent gets its own device and never picks a machine.";
