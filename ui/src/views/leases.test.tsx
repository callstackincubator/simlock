import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LeaseFacts, LeaseTable } from "./leases";
import {
  type LeaseDetails,
  leaseIdFrom,
  leasePath,
  type LeaseRecord,
  leasesOnWorker,
  type TokenRecord,
} from "./leases-model";
import type { WorkerView } from "./workers-model";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function lease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    deviceId: "dev_1",
    grantedAt: NOW - 90_000,
    id: "lse_1",
    lastRenewedAt: NOW - 30_000,
    ownerId: "tok_1",
    requesterId: "tok_1",
    ttlDeadline: NOW + 125_000,
    ttlMs: 215_000,
    ...overrides,
  };
}

function token(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    createdAt: NOW - 1_000_000,
    id: "tok_1",
    label: "ci-runner-3",
    role: "agent",
    ...overrides,
  };
}

const HOST: WorkerView = {
  catalog: [],
  connection: "connected",
  devices: [
    {
      id: "dev_1",
      mode: "slim",
      spec: { imageTag: "base", model: "iPhone 16", osVersion: "18.4", platform: "ios" },
      state: "leased",
    },
  ],
  drained: false,
  id: "wrk_host",
  label: "mac-mini-1",
  lastSeenAt: NOW,
  leases: [],
};

/** The text of every cell with `data-label="<label>"`, without markup. */
function cells(html: string, label: string): string[] {
  const pattern = new RegExp(`<td data-label="${label}"[^>]*>(.*?)</td>`, "g");
  return [...html.matchAll(pattern)].map((match) => text(match[1] ?? ""));
}

/** The text a screen shows, without markup. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function table(leases: readonly LeaseRecord[], tokens: readonly TokenRecord[]): string {
  return renderToStaticMarkup(
    <LeaseTable
      leases={leases}
      tokens={tokens}
      workers={[HOST]}
      now={NOW}
      showWorker
      label="All leases"
    />,
  );
}

describe("the leases views", () => {
  it("a lease's holder shows its token's label with the token id beside it", () => {
    const html = table(
      [lease(), lease({ id: "lse_2", requesterId: "tok_2" })],
      [token(), token({ id: "tok_2", label: "nightly" }), token({ id: "tok_3", label: "other" })],
    );

    expect(cells(html, "Holder")).toEqual(["ci-runner-3 tok_1", "nightly tok_2"]);
  });

  it("a holder with no matching token shows its id alone", () => {
    const html = table(
      [lease({ requesterId: "agent-7" }), lease({ id: "lse_2", requesterId: "tok_9" })],
      // tok_9 is known but has no label.
      [token(), { createdAt: NOW, id: "tok_9", role: "agent" }],
    );

    expect(cells(html, "Holder")).toEqual(["agent-7", "tok_9"]);
  });

  it("a lease row shows its worker, device, mode, image tag and times", () => {
    const html = table([lease()], [token()]);

    expect(cells(html, "Worker")).toEqual(["mac-mini-1"]);
    expect(cells(html, "Device")).toEqual(["iPhone 16 dev_1"]);
    expect(cells(html, "Mode")).toEqual(["slim"]);
    expect(cells(html, "Image tag")).toEqual(["base"]);
    expect(cells(html, "Granted")).toEqual(["1 min 30 s ago"]);
    expect(cells(html, "Expires in")).toEqual(["2 min 5 s"]);
    expect(cells(html, "Last renewed")).toEqual(["30 s ago"]);
  });

  it("no leases shows as one line saying so", () => {
    expect(text(table([], [token()]))).toBe("No leases.");
  });

  it("the table lists leases oldest granted first, whatever order the daemon sends", () => {
    const sent = [
      lease({ grantedAt: NOW - 1_000, id: "lse_newest", workerId: "wrk_a" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_b", workerId: "wrk_b" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_a", workerId: "wrk_b" }),
      lease({ grantedAt: NOW - 9_000, id: "lse_z", workerId: "wrk_a" }),
    ];

    const shown = cells(table(sent, [token()]), "Lease");

    // Granted in the same millisecond: by worker, then by the lease's own id.
    expect(shown).toEqual(["lse_z", "lse_a", "lse_b", "lse_newest"]);
    expect(cells(table(sent.toReversed(), [token()]), "Lease")).toEqual(shown);
  });

  it("a worker's leases are the ones that name it, or every one on a single host", () => {
    const onA = lease({ id: "a", workerId: "wrk_a" });
    const onB = lease({ id: "b", workerId: "wrk_b" });
    const local = lease({ id: "local" });

    const a = { ...HOST, id: "wrk_a" };
    const b = { ...HOST, id: "wrk_b" };

    expect(leasesOnWorker([onA, onB], "wrk_a", [a, b])).toEqual([onA]);
    expect(leasesOnWorker([local], "wrk_host", [HOST])).toEqual([local]);
    // A lease that names no worker, among several, is on none of them.
    expect(leasesOnWorker([local], "wrk_a", [a, b])).toEqual([]);
  });

  it("a gateway lease's page path has no `.` in its last segment, and names the lease again", () => {
    const id = "3f81a2c4-9b7d-4e21-8a55-1c0e6f2d7b93.lse_9f2c";
    const path = leasePath(id);

    // The daemon serves the page only for a path whose last segment has no `.`.
    expect(path.slice(path.lastIndexOf("/") + 1)).not.toContain(".");
    expect(leaseIdFrom(path)).toBe(id);
    expect(leaseIdFrom("/leases")).toBeUndefined();
    // A malformed escape in a pasted address is read as written, not thrown.
    expect(leaseIdFrom("/leases/lse_%E0%A4%A/")).toBe("lse_%E0%A4%A");
  });

  it("a lease's details show its request id when it has one, and its udid", () => {
    const details: LeaseDetails = {
      createdAt: new Date(NOW - 90_000).toISOString(),
      device: "iPhone 16",
      deviceId: "dev_1",
      expiresAt: new Date(NOW + 125_000).toISOString(),
      id: "lse_1",
      mode: "slim",
      imageTag: "base",
      requestId: "req_7d1a",
      udid: "ABCD-1234",
    };
    const facts = (shown: LeaseDetails) =>
      text(
        renderToStaticMarkup(
          <LeaseFacts
            lease={shown}
            record={lease()}
            tokens={[token()]}
            workers={[HOST]}
            now={NOW}
          />,
        ),
      );

    const withRequest = facts(details);
    const { requestId: _dropped, ...withoutRequestId } = details;
    const withoutRequest = facts(withoutRequestId);

    expect(withRequest).toContain("Holder ci-runner-3 tok_1");
    expect(withRequest).toContain("Worker mac-mini-1");
    expect(withRequest).toContain("UDID ABCD-1234");
    expect(withRequest).toContain("Last renewed 30 s ago");
    expect(withRequest).toContain("Granted 1 min 30 s ago");
    expect(withRequest).toContain("Expires in 2 min 5 s");
    expect(withRequest).toContain("Image tag base");
    expect(withRequest).toContain("Request req_7d1a");
    expect(withoutRequest).not.toContain("Request");
  });

  it("a lease's worker is named from the lease itself when no worker view has it", () => {
    const details: LeaseDetails = {
      createdAt: new Date(NOW).toISOString(),
      device: "iPhone 16",
      deviceId: "dev_1",
      expiresAt: new Date(NOW + 60_000).toISOString(),
      id: "wrk_gone.lse_1",
      mode: "full",
      udid: "ABCD-1234",
    };
    const worker = (shown: LeaseDetails) =>
      /Worker (\S+)/.exec(
        text(
          renderToStaticMarkup(
            <LeaseFacts lease={shown} record={undefined} tokens={[]} workers={[]} now={NOW} />,
          ),
        ),
      )?.[1];

    expect(worker({ ...details, worker: { id: "wrk_gone", label: "mac-studio-2" } })).toBe(
      "mac-studio-2",
    );
    expect(worker({ ...details, workerId: "wrk_gone" })).toBe("wrk_gone");
  });
});
