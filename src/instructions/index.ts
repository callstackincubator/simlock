/**
 * The rules an agent must follow to share devices through Simlock, as one self-contained block
 * an operator pastes into an agent's system prompt. Simlock is advisory: it only works when
 * every agent goes through it, so these rules are the half of the system the daemon cannot
 * enforce.
 *
 * The one source of this text. `simlock instructions` prints it and the MCP server serves it
 * as the `simlock://instructions` resource; neither keeps a copy. It is static and
 * frontend-owned (architecture rule 8): the daemon never learns about it. It names no file
 * in this repository (documentation rule 3) -- a reader who installed the package has none.
 */
export const AGENT_INSTRUCTIONS = `# Using Simlock to share iOS simulators and Android emulators

Simlock hands out simulators and emulators to parallel agents so they do not fight over the same device. It only works if every agent follows these rules.

## Never call the platform tools directly

- Do not run \`xcrun simctl\`, \`adb\`, \`avdmanager\`, or \`emulator\` yourself.
- Use \`simlock simctl <args...>\` and \`simlock adb <args...>\` instead. They pass your arguments through unchanged and add the device set or adb server port that reaches Simlock's devices. A bare \`simctl\` or \`adb\` cannot see those devices, and can break other agents' devices.
- Only drive the device you leased. Never touch a device another agent holds.

## Lease a device

1. Set a stable \`SIMLOCK_AGENT_ID\` for your whole session, distinct from every other agent's, and export it before any \`simlock\` command.
2. Run \`simlock catalog\` first to see which device models and OS versions can be leased. Do not guess.
3. Run \`simlock lease --platform <ios|android> --device <model>\` (add \`--os <version>\` to pick a runtime) in the background. It blocks until the device is ready, prints one JSON line on stdout, then keeps running: it renews the lease, and releases it when it exits.
4. Read that one JSON line on stdout: it holds \`lease.id\`, \`lease.ttlDeadline\`, the \`device\`, and an \`environment\` object. Progress (queue position, provisioning, booting) arrives as JSON lines on stderr.
5. If you cannot keep a process running, use \`simlock lease ... --detach\` instead. It prints the same line and exits, and nothing renews the lease for you: run \`simlock lease renew <lease-id>\` before \`ttlDeadline\`, every time, or the lease expires and the device is taken back.

## One lease, and give it back

- Hold at most one lease at a time. Release it before asking for another.
- Release with \`simlock release <lease-id>\`, or by stopping the background \`simlock lease\` process.
- \`simlock release --all\` and \`simlock nuke\` are operator commands. Never run them: they take devices away from every agent.
- Never pass \`--allow-download\` unless a person told you to. It can download many gigabytes.

## Exit codes to handle

- \`10\`: timed out waiting for a device. Retry later, or with a longer \`--timeout\`.
- \`11\`: no capacity, and \`--no-wait\` was set. Retry later, or drop \`--no-wait\` to wait in the queue.
- \`13\`: you already hold a lease or have a request queued. When it is a lease, the error message names it: keep using it, or release it first. When it is a queued request, wait for it or stop the \`simlock lease\` that made it.
- \`14\`: your background \`simlock lease\` ended because Simlock took the lease back (TTL expiry, an operator release, or a device that could not be recovered). The device is no longer yours: stop using it, and lease again if you still need one.

Every failure also writes one JSON line on stderr, \`{"error":{"code":"...","message":"..."}}\`. Branch on \`code\`, not on the message.

## Reach the leased device

- Use \`simlock simctl\` and \`simlock adb\`. On iOS, name the device by the udid in the grant (\`device.driverDeviceId\`).
- If another tool has to call the real binary, use the grant's \`environment\` block: \`SIMLOCK_IOS_DEVICE_SET\` is the path to pass as \`xcrun simctl --set\`, and \`ANDROID_ADB_SERVER_PORT\` is the port \`adb\` reads on its own. \`simlock lease ... --export-env\` prints it as shell \`export\` lines.
- When the device is on another machine (through a gateway), only \`simlock simctl --lease <lease-id>\` and \`simlock adb --lease <lease-id>\` can reach it.
- Some commands are refused on purpose, because they would break the device for Simlock or for other agents. Do not look for a way around them; use \`simlock release\` instead:
  - \`simlock simctl\` refuses \`create\`, \`erase\`, \`delete\`, \`shutdown all\`, \`runtime delete\`, and any option before the subcommand, \`--set\` and \`--profiles\` included.
  - \`simlock adb\` refuses \`kill-server\`, \`emu kill\`, \`emu avd stop\`, \`emu avd snapshot delete\`, any option before the subcommand other than \`-s\`, \`-t\`, \`-d\`, or \`-e\` (\`--version\` and \`--help\` on their own still work), and, when the device is on another machine, a bare \`shell\` with no command to run.

## Over MCP

If Simlock is connected to you as an MCP server, use its four tools instead of the lease commands:

- \`list_devices\`: what can be leased. Call it before leasing.
- \`lease_simulator\`: lease one device. The lease is renewed for you, and released when the MCP server exits.
- \`release_simulator\`: give the device back.
- \`lease_status\`: whether you still hold a lease, and which one. Call it after a context compaction, before assuming you still have a device.

The rules above still apply: reach the device through \`simlock simctl\` and \`simlock adb\`, never through the platform tools.

More: https://github.com/callstackincubator/simlock
`;

/** What `simlock instructions` prints: the Markdown itself, or one JSON object carrying it. */
export function renderInstructions(format: "text" | "json"): string {
  return format === "json"
    ? JSON.stringify({ instructions: AGENT_INSTRUCTIONS })
    : AGENT_INSTRUCTIONS;
}
