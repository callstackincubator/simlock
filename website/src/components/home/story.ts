// why: the hero tells one story in two steps, so its words stay in one place: one machine
// leasing to agents that reach it three ways (the simlock CLI, agent-device, HTTP), then a
// fleet of them behind a gateway that every agent goes through. The social card
// (scripts/og.mjs) reads the second step for its gateway table.
//
// why: every command is in the user docs. The CLI talks only to daemons on its own machine
// (docs/CLI.md); your-mac runs the gateway, so `simlock --gateway lease` reaches it there.
// agent-device leases through Simlock's /v1/agent-device (docs/HTTP-API.md), and remote agents
// use POST /v1/lease-requests. A worker listens on 4701 and a gateway on 4700
// (docs/CONFIGURATION.md, http.port).
//
// why: routing follows gateway.routing in docs/CONFIGURATION.md (a worker with a ready device
// first, then the most free capacity): claude code gets your-mac's ready iPhone; codex's iPhone
// goes to mac-studio, which then has the most free slots; the Pixel goes to linux-box, which has
// the most after that. A slot that is "free" has no device running.

export const gatewayUrl = "gw.example";

export type Via = "CLI" | "AGENT-DEVICE" | "HTTP";

export type Device = { name: string; start: "ready" | "free" };

export type Machine = { name: string; host: string; devices: Device[] };

export type Agent = {
  via: Via;
  agent: string;
  where: string;
  cmd: string;
  device: string;
  worker: string;
  slot: number;
  // why: a warm device is granted at once; the others boot first.
  warm: boolean;
  result: string;
};

export type Step = { label: string; caption: [string, string, string]; machines: Machine[]; agents: Agent[] };

const ready = (name: string): Device => ({ name, start: "ready" });
const free = (name = ""): Device => ({ name, start: "free" });

const yourMac: Machine = { name: "your-mac", host: "macOS", devices: [ready("iPhone 17 Pro"), free("iPhone 17 Pro"), free("Pixel 8")] };

const one: Step = {
  label: "One machine",
  caption: ["One machine.", "Your agents lease its devices three ways:", "the simlock CLI, agent-device, or HTTP."],
  machines: [yourMac],
  agents: [
    { via: "CLI", agent: "claude code", where: "on your-mac", cmd: "simlock lease --platform ios", device: "iPhone 17 Pro", worker: "your-mac", slot: 0, warm: true, result: "iPhone 17 Pro · warm" },
    { via: "AGENT-DEVICE", agent: "codex", where: "on your-mac", cmd: "agent-device open MyApp --platform ios", device: "iPhone 17 Pro", worker: "your-mac", slot: 1, warm: false, result: "iPhone 17 Pro" },
    { via: "HTTP", agent: "ci", where: "→ your-mac:4701", cmd: "POST /v1/lease-requests", device: "Pixel 8", worker: "your-mac", slot: 2, warm: false, result: "Pixel 8" },
  ],
};

const fleet: Step = {
  label: "A fleet of them",
  caption: ["A fleet of them.", "Add Macs and Linux boxes behind a gateway.", "Agents anywhere lease through its one URL."],
  machines: [
    yourMac,
    { name: "mac-studio", host: "macOS", devices: [free("iPhone 17 Pro"), free("iPhone 17 Pro"), free()] },
    { name: "linux-box", host: "Linux", devices: [free("Pixel 8"), free("Pixel 8"), free()] },
  ],
  agents: [
    { via: "CLI", agent: "claude code", where: "on your-mac", cmd: "simlock --gateway lease --platform ios", device: "iPhone 17 Pro", worker: "your-mac", slot: 0, warm: true, result: "iPhone 17 Pro · your-mac" },
    { via: "AGENT-DEVICE", agent: "codex", where: "on a laptop", cmd: "agent-device open MyApp --platform ios", device: "iPhone 17 Pro", worker: "mac-studio", slot: 0, warm: false, result: "iPhone 17 Pro · mac-studio" },
    { via: "HTTP", agent: "ci", where: `→ ${gatewayUrl}:4700`, cmd: "POST /v1/lease-requests", device: "Pixel 8", worker: "linux-box", slot: 0, warm: false, result: "Pixel 8 · linux-box" },
  ],
};

export const steps = [one, fleet];

export const stageLabel =
  "First, three agents lease devices from one Mac: one with the simlock CLI, one through agent-device, whose iPhone streams its screen, and one over HTTP. Then two more machines join a gateway on that Mac, and every agent leases through the gateway, each sent to a different machine.";

// why: BRAND.md colours shell this way: options dimmed, quoted strings in the accent, the rest
// white. The hero renders and types a command from these pieces, as text, never as markup.
export type Token = { text: string; cls: "" | "opt" | "str" };
export function tokens(cmd: string): Token[] {
  return cmd
    .split(/(--[a-z-]+|"[^"]*")/)
    .filter(Boolean)
    .map((text) => ({ text, cls: text.startsWith("--") ? "opt" : text.startsWith('"') ? "str" : "" }));
}

// why: a shell command starts with $; an HTTP request is drawn as an arrow, since no shell runs it.
export const prompt = (via: Via) => (via === "HTTP" ? "→" : "$");
