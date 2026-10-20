export type SlotKind = "leased" | "ready" | "booting" | "free";

export const slotWords: Record<SlotKind, string> = {
  leased: "leased",
  ready: "ready",
  booting: "booting",
  free: "free",
};

export const workers = [
  {
    id: "mac-studio-1",
    platforms: "iOS · Android",
    start: ["ready", "free", "free", "free", "free", "free"],
  },
  {
    id: "mac-studio-2",
    platforms: "iOS · Android",
    start: ["free", "free", "free", "free", "free", "free"],
  },
  { id: "linux-ci-1", platforms: "Android", start: ["ready", "ready", "free", "free"] },
] as { id: string; platforms: string; start: SlotKind[] }[];

export const endSlots: Record<string, SlotKind[]> = {
  "mac-studio-1": ["leased", "booting", "free", "free", "free", "free"],
  "mac-studio-2": ["leased", "free", "free", "free", "free", "free"],
  "linux-ci-1": ["leased", "ready", "free", "free"],
};

export const leases = [
  { holder: "agent-1", device: "iPhone 17 Pro", worker: "mac-studio-1", left: 882 },
  { holder: "ci-runner-3", device: "iPhone 17 Pro", worker: "mac-studio-2", left: 891 },
  { holder: "agent-3", device: "Pixel 8", worker: "linux-ci-1", left: 896 },
];

export const TTL = 900;

export type Wait = { holder: string; device: string; stage: "queued" | "starting"; waited: number };
export const endWait: Wait = {
  holder: "agent-4",
  device: "iPhone 17 Pro",
  stage: "starting",
  waited: 3,
};

export type Ev = { time: string; name: string; text: string };
export const endEvents: Ev[] = [
  { time: "09:41:20", name: "lease.requested", text: "agent-4 · iPhone 17 Pro" },
  { time: "09:41:16", name: "lease.granted", text: "agent-3 · Pixel 8 · linux-ci-1" },
  { time: "09:41:11", name: "lease.granted", text: "ci-runner-3 · iPhone 17 Pro · mac-studio-2" },
  { time: "09:41:10", name: "device.ready", text: "iPhone 17 Pro · mac-studio-2" },
  { time: "09:41:05", name: "lease.requested", text: "ci-runner-3 · iPhone 17 Pro" },
];

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
