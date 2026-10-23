import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LeaseInspection, LeaseRowView } from "../../state/leases";
import type { Paging } from "../../ds";
import { inConsole } from "../../state/test-support";
import { LeaseDetail, LeaseEventList, LeaseTitle } from "./drawer";
import { LeaseTable } from "./index";

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
    model: "iPhone 16",
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
    title: "ci-runner-3",
    worker: { name: "mac-mini-1", to: "/fleet/wrk_host" },
    ...overrides,
  };
}

const PAGING: Paging = {
  go: () => undefined,
  last: 1,
  page: 1,
  range: "1–1 of 1",
  resize: () => undefined,
  size: 25,
  sizes: [25, 50, 100],
  total: 1,
};

function table(rows: readonly LeaseRowView[], narrowed = false): string {
  return inConsole(<LeaseTable rows={rows} narrowed={narrowed} paging={PAGING} />);
}

describe("the lease list", () => {
  it("shows each lease's holder, time left, device and worker, and links to it", () => {
    const html = table([row()]);

    expect(text(html)).toBe(
      "Holder Device Expires in Actions ci-runner-3 iPhone 16 · mac-mini-1 2 min 5 s",
    );
    expect(html).toContain('href="/leases/lse_1/"');
  });

  it("says in words that a lease is expiring, not only in colour", () => {
    const expiring = text(table([row({ expiring: true, remaining: "4 min" })]));
    const fine = text(table([row()]));

    expect(expiring).toContain("expiring, 4 min");
    expect(fine).not.toContain("expiring");
  });

  it("says there are no leases, or none matching the filter or search", () => {
    expect(text(table([]))).toBe("No leases.");
    expect(text(table([], true))).toBe("No leases match this filter or search.");
  });
});

describe("a lease's drawer", () => {
  it("shows the holder as its title with no expiring word while the lease has time", () => {
    const html = inConsole(<LeaseTitle lease={inspection()} />);

    expect(html).toContain('<span class="lease-title">ci-runner-3</span>');
    expect(text(inConsole(<LeaseDetail lease={inspection()} />))).toContain(
      "iPhone 16 18.4 on mac-mini-1",
    );
    expect(text(html)).not.toContain("expiring");
  });

  it("shows an expiring status next to the title once the lease is under 5 minutes from its end", () => {
    const html = inConsole(<LeaseTitle lease={inspection({ expiring: true })} />);

    expect(html).toMatch(/ci-runner-3.*status-warn.*expiring/);
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

describe("a lease's Events tab", () => {
  it("says there are no events for the lease in the last hour, or lists them", () => {
    expect(text(renderToStaticMarkup(<LeaseEventList rows={[]} />))).toBe(
      "No events for this lease in the last hour.",
    );
    const listed = renderToStaticMarkup(
      <LeaseEventList
        rows={[
          {
            id: "e1",
            iso: "2026-10-02T12:00:00.000Z",
            name: "lease.granted",
            summary: "dev_1",
            time: "12:00:00",
            to: "/activity/e1",
          },
        ]}
      />,
    );
    expect(text(listed)).toBe("12:00:00 lease.granted dev_1");
  });
});
