// why: every page, the docs chrome and the social card read these facts, so each is stated once.
// Every command, package and claim must come from the product's docs or repo, never invented.

import type { IconName } from "../components/site/icons";

// why: GitHub Pages serves the repo at /simlock. Astro's `base` and every internal link read
// this, so moving the site to its own domain is a one-line change.
export const BASE = "/simlock";
export const at = (path: string) => (path === "/" ? BASE : `${BASE}${path}`);

export const site = {
  name: "Simlock",
  wordmark: "Simlock",
  // why: no trailing slash, because canonicals, the sitemap and robots.txt append paths to it.
  url: "https://callstackincubator.github.io",
  repo: "https://github.com/callstackincubator/simlock",
  // why: the home page title is "Name: subtitle" (src/site/meta.ts), and it must stay within
  // 60 characters in all.
  subtitle: "Self-hosted simulator cloud for coding agents",
  headline: ["Your own simulator cloud.", "One device per agent."],
  lede: "Simlock leases iOS simulators and Android emulators to your coding agents, one device each, booted and checked. Start on one Mac, then put your Macs and Linux machines behind one URL.",
  // why: 160 characters at most, so search results show it whole.
  description:
    "Simlock leases iOS simulators and Android emulators to parallel coding agents, from one Mac or a self-hosted fleet of Macs and Linux machines behind one URL.",
  install: "npm i -g simlock",
  skill: undefined as string | undefined,
  ogAlt: "Simlock by Callstack. Your own simulator cloud. One device per agent.",
  owner: "Callstack",
  callstack: "https://callstack.com/?utm_source=simlock&utm_medium=referral",
  license: {
    name: "MIT",
    url: "https://github.com/callstackincubator/simlock/blob/main/LICENSE.md",
    spdx: "https://opensource.org/licenses/MIT",
  },
  npm: "https://www.npmjs.com/package/simlock",
  platforms: ["iOS", "Android"],
  language: "TypeScript",
  mark: undefined as string[] | undefined,
};

export const docs = {
  intro: at("/docs/introduction"),
  start: at("/docs/getting-started"),
  cli: at("/docs/cli"),
  config: at("/docs/configuration"),
  http: at("/docs/http-api"),
  client: at("/docs/client"),
  console: at("/docs/console"),
  events: at("/docs/events"),
  llms: at("/llms.txt"),
};

type Link = { text: string; href: string };

export const nav: Link[] = [
  { text: "Docs", href: docs.intro },
  { text: "CLI", href: docs.cli },
  { text: "HTTP API", href: docs.http },
  { text: "GitHub", href: site.repo },
];

export const footer: Link[] = [
  { text: "Docs", href: docs.intro },
  { text: "llms.txt", href: docs.llms },
  { text: "npm", href: site.npm },
  { text: "GitHub", href: site.repo },
  { text: `${site.license.name} license`, href: site.license.url },
  { text: "Callstack", href: site.callstack },
];

// why: pages rendered with `noindex` belong here too, or the sitemap would list them.
export const noindexPaths = [at("/404")];

export const marquee = [
  "iOS simulators",
  "Android emulators",
  "Physical iPhones",
  "Physical Android phones",
  "macOS workers",
  "Linux workers",
  "CLI",
  "MCP",
  "HTTP API",
  "agent-device",
];

export const notFound = ["This device was never leased.", `The rest of ${site.name} is.`];

export const faq = [
  {
    q: "Does Simlock sandbox my agents?",
    a: "No. It is advisory: agents are told to use only devices a lease hands them, and Simlock does not intercept `simctl` or `avdmanager`. What it does enforce is its own reach: it only shuts down, erases or deletes devices it created.",
  },
  {
    q: "What happens when an agent dies holding a device?",
    a: "Every lease has a TTL and lives only while it is renewed. `simlock lease` renews on a timer and releases when it exits, so a killed holder frees its device at once, and one that vanishes costs the device only until the TTL runs out.",
  },
  {
    q: "What if every device is busy?",
    a: "Simlock creates another one, up to a capacity it derives from the machine’s CPU and RAM. After that the request waits in a fair queue, with `--timeout` and `--no-wait` for callers that want something else.",
  },
  {
    q: "Does a worker need an open port to join a fleet?",
    a: "No. A worker dials out to the gateway over one WebSocket, with the gateway URL and a join token from `simlock token create --role worker`, so a Mac behind NAT joins without an inbound port.",
  },
  {
    q: "Can a Linux machine be a worker?",
    a: "Yes, for Android. Emulators run headless with `android.emulator.headless`, as on a Linux CI runner. iOS simulators need a Mac with Xcode.",
  },
  {
    q: "How do agents on other machines reach it?",
    a: "Over the HTTP API, with a token: `POST /v1/lease-requests` on the gateway, then `POST /v1/leases/{id}/exec` to run `simctl` or `adb` on whichever worker holds the device. agent-device can use the gateway as its proxy too.",
  },
];

export const code = {
  http: `curl -X POST https://gw.example/v1/lease-requests \\
  -H "Authorization: Bearer $SIMLOCK_TOKEN" \\
  -d '{"platform":"ios","device":"iPhone 17 Pro"}'`,
  mcp: `{
  "mcpServers": {
    "simlock": {
      "command": "simlock",
      "args": ["mcp"],
      "env": { "SIMLOCK_AGENT_ID": "agent-1" }
    }
  }
}`,
  client: `import { connectSimlock } from 'simlock/client';

const client = await connectSimlock({ principal: 'agent-1' });
const grant = await client.requestLease({ platform: 'ios', model: 'iPhone 17 Pro' });

await client.releaseLease({ leaseId: grant.lease.id });
await client.close();`,
  cli: `simlock lease --platform ios --device "iPhone 16"
simlock simctl install booted ./MyApp.app
simlock release --all`,
  gateway: [
    "# on the gateway",
    "simlock config set mode gateway",
    "simlock config set http.enabled true",
    "simlock token create --role worker",
    "",
    "# on each worker, Mac or Linux",
    "simlock config set gateway.url wss://gw.example:4700",
    "simlock config set gateway.token slk_...",
  ].join("\n"),
};

export const home = {
  setup: [
    { cmd: site.install },
    { cmd: 'simlock lease --platform ios --device "iPhone 16"' },
    { comment: "a booted device, yours until you release it" },
  ] as ({ cmd: string } | { comment: string })[],

  how: {
    label: "How it works",
    headline: ["Start on one Mac.", "Grow into a fleet."],
    steps: [
      {
        title: "Install",
        body: "Install the CLI. The daemon starts on demand, so there is no setup step.",
        cmd: site.install,
      },
      {
        title: "Lease",
        body: "Ask for a platform and a model. You get a booted, checked device no other agent will touch.",
        cmd: 'simlock lease --platform ios --device "iPhone 16"',
      },
      {
        title: "Add machines",
        body: "Run one daemon as a gateway, mint a join token, and point each Mac or Linux worker at it.",
        cmd: "simlock token create --role worker",
      },
    ],
    tabs: [
      {
        id: "cli",
        name: "CLI",
        file: "zsh",
        lang: "sh",
        code: code.cli,
        pkg: "simlock",
        note: "For agents on the machine itself. Lease results are one JSON line on stdout.",
        href: docs.cli,
      },
      {
        id: "mcp",
        name: "MCP",
        file: ".mcp.json",
        lang: "json",
        code: code.mcp,
        pkg: "simlock mcp",
        note: "Four tools for agents that speak MCP: list, lease, release and status.",
        href: at("/docs/cli#simlock-mcp"),
      },
      {
        id: "http",
        name: "HTTP API",
        file: "zsh",
        lang: "sh",
        code: code.http,
        pkg: "POST /v1/lease-requests",
        note: "For agents on other machines, against a worker or a gateway, with a token.",
        href: docs.http,
      },
      {
        id: "client",
        name: "Client",
        file: "lease.ts",
        lang: "ts",
        code: code.client,
        pkg: "simlock/client",
        note: "The typed client the CLI and the MCP server are built on.",
        href: docs.client,
      },
    ],
  },

  feature: {
    label: "Fleet",
    headline: ["One URL in front of", "every machine you own."],
    lede: "A gateway owns no devices. Workers dial out to it, so a Mac behind NAT joins with a URL and a token, and each request goes to a warm device first, then to the machine with the most room.",
    link: { text: "Set up a gateway", href: at("/docs/configuration#modes-gateway-and-worker") },
    window: "zsh",
    code: code.gateway,
  },

  console: {
    label: "Console",
    headline: ["Open one page.", "See who holds what."],
    lede: "The daemon serves the console itself once HTTP is on. Sign in with an operator token, or through the sign-in proxy you already run, and watch every worker, lease and request on the gateway update within about a second.",
    link: { text: "Read about the console", href: docs.console },
    pages: [
      {
        icon: "grid",
        title: "Workers",
        body: "Every worker that joined: its CPU, memory and disk, and a square for each device slot.",
        href: `${docs.console}#workers`,
      },
      {
        icon: "lock",
        title: "Leases",
        body: "Who holds which device on which worker, how long it has left, and its screen, live.",
        href: `${docs.console}#leases`,
      },
      {
        icon: "stack",
        title: "Waiting",
        body: "Each request still in line, how long it has waited, and why no worker has taken it yet.",
        href: `${docs.console}#waiting`,
      },
      {
        icon: "flag",
        title: "Attention",
        body: "Disconnected and drained workers, RAM over budget, and quarantined or stalled devices.",
        href: `${docs.console}#attention`,
      },
    ] as { icon: IconName; title: string; body: string; href: string }[],
  },

  // why: keep the count divisible by 4 and 2, so no row ends half empty.
  cells: {
    label: "What you get",
    headline: ["Devices that manage themselves,", "for agents that don’t wait."],
    items: [
      {
        icon: "lock",
        title: "One lease, one device",
        body: "A device on lease belongs to one agent until it releases it or the TTL runs out.",
        href: docs.cli,
      },
      {
        icon: "cube",
        title: "Devices on demand",
        body: "Nothing free that fits? Simlock creates one, up to what the machine’s CPU and RAM can hold.",
        href: docs.config,
      },
      {
        icon: "stack",
        title: "A fair queue",
        body: "Past capacity, requests wait their turn instead of failing. Use `--timeout` or `--no-wait` to change that.",
        href: docs.cli,
      },
      {
        icon: "flame",
        title: "Warm devices",
        body: "Keep the models you use booted and clean, so the first lease is granted without a boot.",
        href: docs.config,
      },
      {
        icon: "gauge",
        title: "Idle devices cleaned up",
        body: "An unused device is shut down to free RAM, then deleted to free disk.",
        href: docs.config,
      },
      {
        icon: "test",
        title: "Crash recovery",
        body: "When a leased device dies, Simlock reboots it under the same lease and tells the holder.",
        href: docs.cli,
      },
      {
        icon: "signpost",
        title: "Physical phones too",
        body: "Enroll iPhones and Android phones; on release, Simlock uninstalls the apps they did not have.",
        href: at("/docs/cli#leasing-a-physical-device"),
      },
      {
        icon: "package",
        title: "Four ways in",
        body: "The CLI, an MCP server, the HTTP API and a typed client, all on one contract.",
        href: docs.start,
      },
    ] as { icon: IconName; title: string; body: string; href: string }[],
  },

  safe: {
    label: "Safe by default",
    headline: ["It only touches", "what it made."],
    items: [
      {
        icon: "lock",
        title: "Your devices stay yours",
        body: "Simlock only shuts down, erases or deletes devices it created. Everything else is read-only to it.",
      },
      {
        icon: "network",
        title: "Nothing listens by default",
        body: "The HTTP API and the console are off until you set `http.enabled`, and bind to loopback.",
      },
      {
        icon: "faders",
        title: "Tokens with roles",
        body: "Agents, operators and workers get their own tokens, hashed at rest and revocable.",
      },
      {
        icon: "code",
        title: "Passthrough with limits",
        body: "`simlock simctl` and `simlock adb` refuse verbs that would change a device behind its lease.",
      },
    ] as { icon: IconName; title: string; body: string }[],
  },
};
