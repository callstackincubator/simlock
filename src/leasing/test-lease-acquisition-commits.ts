import { vi } from "vitest";

import type { StateDatabase } from "../state/index.js";

interface StoredByCommit {
  readonly leaseRequesters: readonly string[];
  readonly requestRequesters: readonly string[];
}

/**
 * why: runs `inspect` inside every registry commit, once its rows are written and before it commits: it
 * sees what the commit stores, and throwing from it rolls that commit back.
 */
export function inspectCommits(
  harness: { readonly state: StateDatabase },
  inspect: (stored: StoredByCommit) => void,
): void {
  const original = harness.state.transaction.bind(harness.state);
  vi.spyOn(harness.state, "transaction").mockImplementation((work) =>
    original(() => {
      const result = work();
      const requesters = (table: string) =>
        harness.state.database
          .prepare(`SELECT requester_id FROM ${table}`)
          .all()
          .map((row) => String(row["requester_id"]));
      inspect({
        leaseRequesters: requesters("leases"),
        requestRequesters: requesters("lease_requests"),
      });
      return result;
    }),
  );
}
