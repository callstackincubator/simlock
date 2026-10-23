const TITLE = "# Using Simlock to share iOS simulators and Android emulators";

const INTRO =
  "Simlock hands out simulators and emulators to parallel agents so they do not fight over the same device. It only works if every agent follows these rules.";

const RULES_FOR_EVERY_AGENT = `## Rules for every agent

- Never run the platform tools yourself: not \`xcrun simctl\`, \`adb\`, \`avdmanager\` or \`emulator\`. They cannot see Simlock's devices and can break other agents' devices.
- Drive only the device you leased. Never touch a device another agent holds.
- Under Claude Code and Codex your identity is automatic: do not set \`SIMLOCK_AGENT_ID\`. Under any other tool, set a \`SIMLOCK_AGENT_ID\` of your own and keep it for the whole session. Never share one with another agent.
- The operator decides how many leases you may hold. When a request fails with \`REQUESTER_ALREADY_LEASED\`, use the lease you hold, or release it first.
- Never pass \`--allow-download\` unless a person told you to. It can download many gigabytes.
- Never run \`simlock release --all\` or \`simlock nuke\`. They take devices away from every agent.
- Check that Simlock is set up for you with \`simlock whoami\`.`;

const AGENT_DEVICE = `## agent-device

- Get a token and the URL from the operator. Set \`AGENT_DEVICE_DAEMON_AUTH_TOKEN\` to the token, then run \`agent-device connect proxy --daemon-base-url <url>/v1/agent-device\` once. Through a gateway, the URL is the gateway's.
- When other agents run on the same machine, pass your own \`--session <name>\` on every command, or set \`AGENT_DEVICE_SESSION\`.
- \`agent-device open --platform <ios|android> --device <model>\` leases a device. It may wait in a queue.
- \`agent-device install <app> <path>\` uploads the app from your machine.
- \`agent-device close\` gives the device back.
- When a command answers "lease ended by simlock; run disconnect, then open", the lease is over and the old device and its data are gone: run \`agent-device disconnect\`, then \`open\` again.`;

const IOS_BUILDS = `## iOS builds

Simlock's simulators live in a device set of their own, not the default set that Xcode and \`xcrun simctl\` use. A tool that picks a simulator from the default set cannot find them.

- Do not build against your leased device: \`xcodebuild -destination id=<udid>\`, \`react-native run-ios\`, \`expo run:ios\`, Detox and Maestro cannot find it, so they fail. Build for any simulator instead with \`-destination 'generic/platform=iOS Simulator'\`.
- Then install the \`.app\` with \`agent-device install\`, or with \`simlock simctl install <device.address> <path-to-.app>\` when the path is on the machine that runs Simlock.`;

const SIMLOCK_CLI = `## simlock CLI

- Run \`simlock catalog\` first to see which devices can be leased. Do not guess.
- Lease in the background: \`simlock lease --platform <ios|android> --device <model>\`. It prints one JSON line on stdout and progress on stderr, renews the lease while it runs, and releases it when it exits. \`--bind-pid <pid>\` ties the lease to another process instead.
- Without a background process, use \`--detach\` with \`--ttl <duration>\`, and run \`simlock lease renew <lease-id>\` before \`lease.ttlDeadline\`, every time. Nothing else renews it.
- Add \`--physical\` to lease an enrolled phone.
- The JSON line holds \`lease.id\`, \`lease.ttlDeadline\`, \`device.address\` and \`environment\`. \`--export-env\` prints \`environment\` as shell \`export\` lines.
- Release with \`simlock release <lease-id>\`, or stop the background \`simlock lease\`.
- Reach the device through \`simlock simctl\` and \`simlock adb -s <device.address>\`, or through the grant's \`environment\`. On another machine, use \`simlock simctl --lease <lease-id>\` and \`simlock adb --lease <lease-id>\`.
- If this machine runs a gateway and the operator says to use it, put \`--gateway\` right after \`simlock\`.

Some commands are refused on purpose, because they break the device for Simlock or for other agents. Do not work around them; release the lease instead.

- \`simlock simctl\` refuses \`simlock simctl create\`, \`simlock simctl erase\`, \`simlock simctl delete\`, \`simlock simctl shutdown all\` and \`simlock simctl runtime delete\`.
- \`simlock simctl\` refuses any option before the subcommand, \`--set\` and \`--profiles\` included.
- \`simlock adb kill-server\`, \`simlock adb emu kill\`, \`simlock adb emu avd stop\` and \`simlock adb emu avd snapshot delete\` are refused.
- \`simlock adb\` refuses any option before the subcommand other than \`-s\`, \`-t\`, \`-d\` or \`-e\`.
- On another machine, \`simlock adb shell\` needs a command to run.

Exit codes:

- \`10\`: timed out waiting for a device. Retry later.
- \`11\`: no capacity and \`--no-wait\` was set. Retry later, or drop \`--no-wait\` to wait in the queue.
- \`13\`: you already hold a lease or have a request queued. Use that lease, or release it first.
- \`14\`: Simlock took your background lease back. The device is no longer yours: stop using it, and lease again if you still need one.

Every failure writes one JSON line on stderr, \`{"error":{"code":"...","message":"..."}}\`. Branch on \`code\`, not on the message.`;

const MCP = `## MCP

When Simlock is connected to you as an MCP server, it has four tools:

- \`list_devices\`: what can be leased. Call it before leasing.
- \`lease_simulator\`: lease one device. It is renewed for you and released when the server exits.
- \`release_simulator\`: give the device back.
- \`lease_status\`: whether you still hold a lease, and which. Call it after a context compaction.

The tools lease and release only. Install and launch through \`simlock simctl\` and \`simlock adb\` with \`device.address\`. Under Codex, the MCP server and the CLI are two identities: use only one of them per session.`;

const MORE = "More: https://callstackincubator.github.io/simlock/docs/";

export const AGENT_INSTRUCTIONS = `${[
  TITLE,
  INTRO,
  RULES_FOR_EVERY_AGENT,
  AGENT_DEVICE,
  IOS_BUILDS,
  SIMLOCK_CLI,
  MCP,
  MORE,
].join("\n\n")}\n`;

export const MCP_SERVER_INSTRUCTIONS = `${[
  TITLE,
  RULES_FOR_EVERY_AGENT,
  MCP,
  "Run `simlock instructions` for the rest: agent-device, iOS builds and the CLI.",
].join("\n\n")}\n`;

export function renderInstructions(format: "text" | "json"): string {
  return format === "json"
    ? JSON.stringify({ instructions: AGENT_INSTRUCTIONS })
    : AGENT_INSTRUCTIONS;
}

export { renderSkill } from "./skill.js";
export {
  AGENT_TOOL_IDS,
  agentToolName,
  SetupMcpFailedError,
  SetupRefusedError,
  setupAgentTools,
  toolRunner,
} from "./setup.js";
export type {
  AgentTool,
  SetupAgentToolsOptions,
  SetupReport,
  ToolOutcome,
  RunTool,
} from "./setup.js";
