import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ApiClient, Fetch } from "../../data/api";
import type { Preferences } from "../../data/preferences";
import type { Session } from "../../data/session";
import { ConsoleProvider } from "../../state/services";
import type { LeaseInspection, LeaseRowView } from "../../state/leases";
import type { Screen } from "../../state/screen";
import { LeaseRows } from "./index";
import { LeaseDetail } from "./inspector";
import { ScreenView } from "./screen-panel";

// why: a panel rendered for a claim about its markup never talks to a daemon, so the services it
// reads are there to satisfy the context, and a call into either would be the finding.
function inConsole(node: ReactNode): string {
  const services = {
    api: {} as unknown as ApiClient,
    fetch: (() => Promise.reject(new Error("unused"))) as unknown as Fetch,
    preferences: {} as unknown as Preferences,
    session: {} as unknown as Session,
  };
  return renderToStaticMarkup(<ConsoleProvider {...services}>{node}</ConsoleProvider>);
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function row(overrides: Partial<LeaseRowView> = {}): LeaseRowView {
  return {
    expiring: false,
    holder: "ci-runner-3",
    id: "lse_1",
    key: " lse_1",
    percent: 50,
    remaining: "2 min 5 s",
    sub: "iPhone 16 · mac-mini-1",
    to: "/leases/lse_1/",
    ...overrides,
  };
}

function inspection(overrides: Partial<LeaseInspection> = {}): LeaseInspection {
  return {
    device: {
      deviceId: "dev_1",
      imageTag: "base",
      kind: "Virtual",
      mode: "slim",
      udid: "ABCD-1234",
    },
    expiring: false,
    granted: "11:58",
    heldFor: "1 min 30 s",
    holder: { id: "tok_1", label: "ci-runner-3" },
    id: "lse_1",
    model: "iPhone 16",
    percent: 50,
    remaining: "2 min 5 s",
    renewed: "30 s ago",
    requestId: "req_7d1a",
    runtime: "18.4",
    stream: { offered: true },
    title: "ci-runner-3",
    worker: { name: "mac-mini-1", to: "/workers/wrk_host" },
    ...overrides,
  };
}

const IDLE: Screen = {
  canvas: { current: null },
  height: 0,
  live: false,
  note: undefined,
  readout: {
    facts: [
      { label: "Picture", value: "—" },
      { label: "Frames", value: "—" },
      { label: "Rate", value: "—" },
      { label: "Bandwidth", value: "—" },
      { label: "Dropped", value: "—" },
    ],
    state: { tone: "idle", word: "off" },
  },
  start: () => undefined,
  stop: () => undefined,
  waiting: undefined,
  width: 0,
};

describe("the lease list", () => {
  it("shows each lease's holder, time left, device and worker, and links to it", () => {
    const html = renderToStaticMarkup(<LeaseRows rows={[row()]} chosen={undefined} filter="all" />);

    expect(text(html)).toBe("ci-runner-3 2 min 5 s iPhone 16 · mac-mini-1");
    expect(html).toContain('href="/leases/lse_1/"');
  });

  it("marks the chosen row as current, and no other", () => {
    const html = renderToStaticMarkup(
      <LeaseRows
        rows={[row(), row({ id: "lse_2", key: " lse_2", to: "/leases/lse_2/" })]}
        chosen="lse_2"
        filter="all"
      />,
    );

    const current = [...html.matchAll(/<a [^>]*>/g)]
      .map(([tag = ""]) => tag)
      .filter((tag) => tag.includes('aria-current="page"'));

    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/leases/lse_2/"');
  });

  it("says in words that a lease is expiring, not only in colour", () => {
    const expiring = text(
      renderToStaticMarkup(
        <LeaseRows rows={[row({ expiring: true, remaining: "4 min" })]} chosen="x" filter="all" />,
      ),
    );
    const fine = text(renderToStaticMarkup(<LeaseRows rows={[row()]} chosen="x" filter="all" />));

    expect(expiring).toContain("expiring, 4 min");
    expect(fine).not.toContain("expiring");
  });

  it("says there are no leases, or none matching the filter", () => {
    expect(
      text(renderToStaticMarkup(<LeaseRows rows={[]} chosen={undefined} filter="all" />)),
    ).toBe("No leases.");
    expect(
      text(renderToStaticMarkup(<LeaseRows rows={[]} chosen={undefined} filter="ios" />)),
    ).toBe("No leases match this filter.");
  });
});

describe("a lease's inspector", () => {
  it("shows the holder as its title with no expiring word while the lease has time", () => {
    const html = inConsole(<LeaseDetail lease={inspection()} />);

    expect(html).toMatch(/<h2[^>]*>[^<]*<span class="lease-title">ci-runner-3<\/span>/);
    expect(text(html)).toContain("iPhone 16 18.4 on mac-mini-1");
    expect(text(html)).not.toContain("expiring");
  });

  it("shows an expiring status next to the title once the lease is under 15 minutes from its end", () => {
    const html = inConsole(<LeaseDetail lease={inspection({ expiring: true })} />);

    expect(html).toMatch(/<h2[^>]*>.*ci-runner-3.*status-warn.*expiring/);
  });

  it("shows every fact the old details panel showed, in its cards", () => {
    const html = text(inConsole(<LeaseDetail lease={inspection()} />));

    expect(html).toContain("Expires in 2 min 5 s");
    expect(html).toContain("Held for 1 min 30 s");
    expect(html).toContain("Renewed 30 s ago");
    expect(html).toContain("Granted 11:58");
    expect(html).toContain("Mode slim");
    expect(html).toContain("Image tag base");
    expect(html).toContain("Worker mac-mini-1");
    expect(html).toContain("UDID ABCD-1234");
    expect(html).toContain("Request req_7d1a");
    expect(html).toContain("Holder ci-runner-3 tok_1");
  });

  it("leaves out the request when there is none, and shows a physical device's mode as missing", () => {
    const { requestId: _dropped, ...bare } = inspection();
    const { mode: _mode, imageTag: _tag, ...device } = inspection().device;

    const html = text(
      inConsole(<LeaseDetail lease={{ ...bare, device: { ...device, kind: "Physical" } }} />),
    );

    expect(html).not.toContain("Request");
    expect(html).toContain("Mode — Image tag — Kind Physical");
  });
});

describe("the screen panel before anything is asked for", () => {
  it("offers the one control a screen has and says there is no picture while it is off", () => {
    const html = renderToStaticMarkup(<ScreenView screen={IDLE} offered reason={undefined} />);

    expect(html).toContain("Show screen");
    expect(html).not.toContain("disabled");
    expect(html).toContain("No picture while this is off.");
    expect(html).not.toContain("<canvas");
  });

  it("shows the state as a word, and every figure it cannot yet fill as missing", () => {
    const html = renderToStaticMarkup(<ScreenView screen={IDLE} offered reason={undefined} />);
    const words = [...html.matchAll(/<dt>([^<]*)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(
      ([, label = "", value = ""]) => `${label}=${text(value)}`,
    );

    expect(words).toEqual([
      "State=off",
      "Picture=—",
      "Frames=—",
      "Rate=—",
      "Bandwidth=—",
      "Dropped=—",
    ]);
  });

  it("disables Show screen and says why before any click when the worker has streaming off", () => {
    const html = renderToStaticMarkup(
      <ScreenView screen={IDLE} offered={false} reason="Streaming is off on mac-mini-1." />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Show screen<\/button>/);
    expect(text(html)).toContain("Streaming is off on mac-mini-1.");
  });
});

describe("the screen panel while a picture is asked for", () => {
  const live: Screen = {
    ...IDLE,
    height: 240,
    live: true,
    readout: { ...IDLE.readout, state: { tone: "ok", word: "live" } },
    waiting: "Waiting for the first frame.",
    width: 120,
  };

  it("offers Stop, mounts the canvas, and says it is waiting for the first frame", () => {
    const html = renderToStaticMarkup(<ScreenView screen={live} offered reason={undefined} />);

    expect(html).toContain(">Stop<");
    expect(html).toContain('aria-label="The leased device&#x27;s screen"');
    expect(html).toContain("Waiting for the first frame.");
    expect(html).not.toContain("No picture while this is off.");
  });

  it("shows a refusal as an alert, and no canvas, once the stream has stopped", () => {
    const html = renderToStaticMarkup(
      <ScreenView screen={{ ...IDLE, note: "Unknown lease: lse_1" }} offered reason={undefined} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Unknown lease: lse_1");
    expect(html).not.toContain("<canvas");
  });
});
