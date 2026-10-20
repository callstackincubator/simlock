// why: the hero tells one story in two acts, so its words stay in one place: one Mac leasing to
// its own agents, then the same Mac behind a gateway with two more machines. The social card
// (scripts/og.mjs) reads the second act for its gateway table.
//
// why: routing reasons follow gateway.routing in docs/CONFIGURATION.md (a warm device first,
// then the most free capacity). agent-1 hits your-mac's warm iPhone; agent-2 goes to mac-studio
// (two free slots against your-mac's one; linux-box cannot run iOS); agent-3 goes to linux-box
// (two free slots against one each elsewhere). The gateway and a worker can share one machine
// (docs/CONFIGURATION.md, "Gateway and worker modes"), so your-mac runs both.

export const gatewayUrl = "gw.example";

export type Slot = { device?: string; start: "ready" | "free" };

export type Machine = { name: string; host: string; foot: string; slots: Slot[] };

export type Agent = {
  where: string;
  agent: string;
  cmd: string;
  device: string;
  // why: an index into the act's slots, counted across its machines in order.
  slot: number;
  // why: a warm device is granted at once; the others boot first.
  boots: boolean;
  route?: { worker: string; why: string };
};

export type Act = { label: string; cmd: string; machines: Machine[]; agents: Agent[] };

const local: Act = {
  label: "One Mac",
  cmd: "npm i -g simlock",
  machines: [
    {
      name: "your-mac",
      host: "macOS · iOS · Android",
      foot: "simlock · leases, boots, cleans up",
      slots: [
        { device: "iPhone 17 Pro", start: "ready" },
        { device: "iPhone 17 Pro", start: "free" },
        { device: "Pixel 8", start: "free" },
        { start: "free" },
      ],
    },
  ],
  agents: [
    { where: "your-mac", agent: "agent-1", cmd: "simlock lease --platform ios", device: "iPhone 17 Pro", slot: 0, boots: false },
    { where: "your-mac", agent: "agent-2", cmd: "simlock lease --platform ios", device: "iPhone 17 Pro", slot: 1, boots: true },
    { where: "your-mac", agent: "agent-3", cmd: "simlock lease --platform android", device: "Pixel 8", slot: 2, boots: true },
  ],
};

const fleet: Act = {
  label: "More machines",
  cmd: `simlock config set gateway.url wss://${gatewayUrl}:4700`,
  machines: [
    {
      name: "your-mac",
      host: "macOS · iOS · Android",
      foot: "worker · runs the gateway too",
      slots: [{ device: "iPhone 17 Pro", start: "ready" }, { start: "free" }],
    },
    {
      name: "mac-studio",
      host: "macOS · iOS · Android",
      foot: "worker · joined",
      slots: [{ device: "iPhone 17 Pro", start: "free" }, { start: "free" }],
    },
    {
      name: "linux-box",
      host: "Linux · Android",
      foot: "worker · joined",
      slots: [{ device: "Pixel 8", start: "free" }, { start: "free" }],
    },
  ],
  agents: [
    { where: "laptop", agent: "agent-1", cmd: "POST /v1/lease-requests", device: "iPhone 17 Pro", slot: 0, boots: false, route: { worker: "your-mac", why: "warm device" } },
    { where: "ci", agent: "agent-2", cmd: "POST /v1/lease-requests", device: "iPhone 17 Pro", slot: 2, boots: true, route: { worker: "mac-studio", why: "most free capacity" } },
    { where: "claude code", agent: "agent-3", cmd: "POST /v1/lease-requests", device: "Pixel 8", slot: 4, boots: true, route: { worker: "linux-box", why: "most free capacity" } },
  ],
};

export const acts = [local, fleet];

export const stageLabel =
  "First, three agents on one Mac lease their own devices from Simlock: a warm iPhone at once, and an iPhone and a Pixel booted for them. Then two more machines join a gateway, and agents anywhere lease through its one URL, each sent to a different machine.";
