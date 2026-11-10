import { describe, expect, it } from "vitest";

import { configSchema } from "../contract/index.js";
import { FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { ALERT_EVENTS, ALERT_FORMATS, type Config, loadConfig } from "./index.js";

const configPath = "/home/agent/.simlock/config.json";
const gibibyte = 1024 ** 3;

function createStats(): FakeSystemStats {
  return new FakeSystemStats({
    cpuCount: 8,
    totalRamBytes: 32 * gibibyte,
  });
}

describe("gateway.alerts.destinations", () => {
  const validDestination = {
    name: "audit",
    format: "generic",
    url: "https://n8n.example.com/x",
    events: ["worker.connected"],
    secret: "s3cr3t",
  };
  const nameExpected =
    "expected a name of lowercase letters, digits and dashes that starts with a letter, at most 32 characters";
  const urlExpected =
    "expected an https:// URL, or an http:// URL to localhost, 127.0.0.1 or [::1], with no user name or password";
  const formatExpected = 'expected one of "generic", "slack"';
  const eventsExpected = `expected a non-empty list of alert events, each once: ${ALERT_EVENTS.join(", ")}`;

  async function load(
    gateway: Record<string, unknown>,
    role: "gateway" | "worker" = "gateway",
    warn: (message: string) => void = () => {},
  ): Promise<Config> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify({ gateway }));
    return loadConfig({ configPath, filesystem, role, systemStats: createStats(), warn });
  }

  function loadDestinations(destinations: unknown, role: "gateway" | "worker" = "gateway") {
    return load({ alerts: { destinations } }, role);
  }

  it("loadConfig accepts a valid generic destination and defaults gateway.alerts.destinations to an empty list", async () => {
    expect((await load({})).gateway.alerts.destinations).toEqual([]);
    for (const url of [
      "https://n8n.example.com/x",
      "http://localhost:5678/x",
      "http://127.0.0.1/x",
      "http://[::1]:80/x",
    ]) {
      const config = await loadDestinations([{ ...validDestination, url }]);
      expect(config.gateway.alerts.destinations).toEqual([{ ...validDestination, url }]);
    }
    const names = await loadDestinations([
      { ...validDestination, name: "ops-1" },
      validDestination,
    ]);
    expect(names.gateway.alerts.destinations.map((each) => each.name)).toEqual(["ops-1", "audit"]);
  });

  const bad = (field: string, value: unknown) => ({ ...validDestination, [field]: value });
  const without = (field: string) => {
    const { [field as "name"]: _omitted, ...rest } = validDestination;
    return rest;
  };

  it.each([
    ["name", bad("name", "Audit"), nameExpected],
    ["name", bad("name", "1ops"), nameExpected],
    ["name", bad("name", "a_b"), nameExpected],
    ["name", bad("name", ""), nameExpected],
    ["name", bad("name", "a".repeat(33)), nameExpected],
    ["name", without("name"), nameExpected],
    ["format", bad("format", "teams"), formatExpected],
    ["format", bad("format", "json"), formatExpected],
    ["format", without("format"), formatExpected],
    ["url", bad("url", "http://n8n.internal/x"), urlExpected],
    ["url", bad("url", "ftp://example.com"), urlExpected],
    ["url", bad("url", "n8n.example.com/x"), urlExpected],
    ["url", bad("url", "https://user:pw@host/x"), urlExpected],
    ["url", bad("url", "https://user@host/x"), urlExpected],
    ["url", bad("url", "https://:pw@host/x"), urlExpected],
    ["url", bad("url", ""), urlExpected],
    ["url", without("url"), urlExpected],
    ["events", bad("events", []), eventsExpected],
    ["events", bad("events", ["lease.granted"]), eventsExpected],
    ["events", bad("events", ["worker.connected", "worker.connected"]), eventsExpected],
    ["events", without("events"), eventsExpected],
    ["secret", bad("secret", ""), "expected a non-empty secret for a generic destination"],
    ["secret", without("secret"), "expected a non-empty secret for a generic destination"],
  ])("loadConfig refuses a bad %s with its message", async (field, destination, expected) => {
    await expect(loadDestinations([validDestination])).resolves.toBeDefined();
    await expect(loadDestinations([destination])).rejects.toThrow(
      `Invalid config value for "gateway.alerts.destinations[0].${field}": ${expected}`,
    );
  });

  it("loadConfig accepts a slack destination, refuses a secret on it, and lists both formats in the format message", async () => {
    const { secret: _secret, ...slack } = { ...validDestination, format: "slack" };
    const config = await loadDestinations([slack]);
    expect(config.gateway.alerts.destinations).toEqual([slack]);

    for (const secret of ["s", "", null]) {
      await expect(loadDestinations([{ ...slack, secret }])).rejects.toThrow(
        'Invalid config value for "gateway.alerts.destinations[0].secret": expected no secret: a slack destination is not signed',
      );
    }
    await expect(
      loadDestinations([{ ...slack, url: "https://user:pw@hooks.slack.com/x" }]),
    ).rejects.toThrow(
      `Invalid config value for "gateway.alerts.destinations[0].url": ${urlExpected}`,
    );
    await expect(loadDestinations([bad("format", "teams")])).rejects.toThrow(
      `Invalid config value for "gateway.alerts.destinations[0].format": ${formatExpected}`,
    );
  });

  it("loadConfig refuses a repeated name, a bad list and a bad entry, on a gateway and on a worker", async () => {
    await expect(loadDestinations([validDestination, validDestination])).rejects.toThrow(
      'Invalid config value for "gateway.alerts.destinations[1].name": expected a name no other destination uses',
    );
    const sixteen = Array.from({ length: 16 }, (_, index) => ({
      ...validDestination,
      name: `d${index}`,
    }));
    await expect(loadDestinations(sixteen)).resolves.toBeDefined();
    for (const list of [[...sixteen, validDestination], {}, "x"]) {
      await expect(loadDestinations(list)).rejects.toThrow(
        'Invalid config value for "gateway.alerts.destinations": expected a list of at most 16 destinations',
      );
    }
    for (const entry of ["x", null, []]) {
      await expect(loadDestinations([entry])).rejects.toThrow(
        'Invalid config value for "gateway.alerts.destinations[0]": expected an object',
      );
    }
    await expect(loadDestinations([bad("url", "ftp://x")], "worker")).rejects.toThrow(
      `Invalid config value for "gateway.alerts.destinations[0].url": ${urlExpected}`,
    );
  });

  it("loadConfig reports name before url when two fields are bad, and the first bad destination", async () => {
    await expect(
      loadDestinations([
        { ...validDestination, url: "ftp://x", name: "Bad" },
        { ...validDestination, name: "Worse" },
      ]),
    ).rejects.toThrow(`"gateway.alerts.destinations[0].name": ${nameExpected}`);
  });

  it("loadConfig warns about an unknown key inside a destination and still loads", async () => {
    const warnings: string[] = [];
    const config = await load(
      { alerts: { destinations: [{ ...validDestination, headers: {} }] } },
      "gateway",
      (message) => warnings.push(message),
    );
    expect(warnings).toEqual(['Unknown config key: "gateway.alerts.destinations[0].headers"']);
    expect(config.gateway.alerts.destinations).toEqual([validDestination]);
  });

  it("config.get's format enum lists exactly core's ALERT_FORMATS", () => {
    const destination = configSchema.shape.gateway.shape.alerts.shape.destinations.element;
    expect(destination.shape.format.options).toEqual([...ALERT_FORMATS]);
  });

  it("config.get's schema keeps every field of a loaded destination, a slack one without a secret", async () => {
    const { secret: _secret, ...slack } = { ...validDestination, name: "chat", format: "slack" };
    const config = await loadDestinations([validDestination, slack]);
    expect(config.gateway.alerts.destinations[1]).toEqual(slack);
    const parsed = configSchema.parse(config);
    expect(parsed.gateway.alerts).toEqual(config.gateway.alerts);
  });
});
