import type { Statements } from "./statements.js";

interface OpenRequest {
  readonly platform: string;
  readonly probe: boolean;
}

interface NewRequest {
  readonly requestId: string;
  readonly requester: string;
  readonly platform: string;
  readonly model: string | undefined;
  readonly at: number;
  readonly probe: boolean;
}

const OPEN = "grantedAt IS NULL AND rejectedAt IS NULL";

function changed(result: { readonly changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}

export class Ledger {
  readonly #statements: Statements;

  constructor(statements: Statements) {
    this.#statements = statements;
  }

  insertRequest(request: NewRequest): boolean {
    return changed(
      this.#statements
        .get(
          `INSERT OR IGNORE INTO request_rows (requestId, requester, platform, model, requestedAt, probe)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.requestId,
          request.requester,
          request.platform,
          request.model ?? null,
          request.at,
          request.probe ? 1 : 0,
        ),
    );
  }

  insertRefusal(
    request: Omit<NewRequest, "probe">,
    refusal: { readonly reason: string | null; readonly workerId: string | null },
  ): void {
    this.#statements
      .get(
        `INSERT OR IGNORE INTO request_rows
           (requestId, requester, platform, model, requestedAt, rejectedAt, reason, workerId, probe, refusedAtAdmission)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      )
      .run(
        request.requestId,
        request.requester,
        request.platform,
        request.model ?? null,
        request.at,
        request.at,
        refusal.reason,
        refusal.workerId,
      );
  }

  exists(requestId: string): boolean {
    return (
      this.#statements
        .get("SELECT 1 AS found FROM request_rows WHERE requestId = ?")
        .get(requestId) !== undefined
    );
  }

  findOpen(requestId: string): OpenRequest | undefined {
    const row = this.#statements
      .get(`SELECT platform, probe FROM request_rows WHERE requestId = ? AND ${OPEN}`)
      .get(requestId);
    return row === undefined
      ? undefined
      : { platform: String(row.platform), probe: row.probe === 1 };
  }

  requestPlatform(requestId: string): string | undefined {
    const row = this.#statements
      .get("SELECT platform FROM request_rows WHERE requestId = ?")
      .get(requestId);
    return row === undefined ? undefined : String(row.platform);
  }

  reject(
    requestId: string,
    outcome: {
      readonly at: number;
      readonly reason: string | null;
      readonly workerId: string | null;
      readonly declined: boolean;
    },
  ): void {
    this.#statements
      .get(
        `UPDATE request_rows SET rejectedAt = ?, reason = ?, workerId = COALESCE(workerId, ?), declined = ?
         WHERE requestId = ? AND ${OPEN}`,
      )
      .run(outcome.at, outcome.reason, outcome.workerId, outcome.declined ? 1 : null, requestId);
  }

  grant(
    requestId: string,
    grant: { readonly at: number; readonly source: string | null; readonly leaseId: string },
  ): void {
    this.#statements
      .get(
        `UPDATE request_rows SET grantedAt = ?, source = ?, leaseId = ? WHERE requestId = ? AND ${OPEN}`,
      )
      .run(grant.at, grant.source, grant.leaseId, requestId);
  }

  grantDispatched(
    requestId: string,
    grant: {
      readonly at: number;
      readonly workerId: string | null;
      readonly workerLeaseId: string | null;
      readonly leaseId: string | null;
    },
  ): void {
    this.#statements
      .get(
        `UPDATE request_rows SET grantedAt = ?, workerId = ?, workerLeaseId = ?, leaseId = ?,
           source = (SELECT source FROM held_leases WHERE workerId = ? AND leaseId = ?)
         WHERE requestId = ? AND ${OPEN}`,
      )
      .run(
        grant.at,
        grant.workerId,
        grant.workerLeaseId,
        grant.leaseId,
        grant.workerId,
        grant.workerLeaseId,
        requestId,
      );
  }

  rejectAllOpen(at: number, reason: string): void {
    this.#statements
      .get(`UPDATE request_rows SET rejectedAt = ?, reason = ? WHERE ${OPEN}`)
      .run(at, reason);
  }

  endByLease(
    leaseId: string,
    end: { readonly at: number; readonly endReason: string | null },
  ): void {
    this.#statements
      .get(
        `UPDATE request_rows SET endedAt = ?, endReason = ?, heldMs = MAX(0, ? - grantedAt)
         WHERE leaseId = ? AND endedAt IS NULL AND grantedAt IS NOT NULL`,
      )
      .run(end.at, end.endReason, end.at, leaseId);
  }

  endByWorkerLease(
    workerId: string,
    leaseId: string,
    end: {
      readonly at: number;
      readonly endReason: string | null;
      readonly heldFrom: number | null;
    },
  ): void {
    this.#statements
      .get(
        `UPDATE request_rows SET endedAt = ?, endReason = ?, heldMs = ?
         WHERE workerId = ? AND workerLeaseId = ? AND endedAt IS NULL`,
      )
      .run(
        end.at,
        end.endReason,
        end.heldFrom === null ? null : Math.max(0, end.at - end.heldFrom),
        workerId,
        leaseId,
      );
  }

  attachSource(workerId: string, leaseId: string, source: string): void {
    this.#statements
      .get(
        `UPDATE request_rows SET source = ?
         WHERE workerId = ? AND workerLeaseId = ? AND source IS NULL AND grantedAt IS NOT NULL`,
      )
      .run(source, workerId, leaseId);
  }

  holdLease(
    workerId: string,
    lease: {
      readonly leaseId: string;
      readonly platform: string;
      readonly source: string | null;
      readonly at: number;
    },
  ): boolean {
    return changed(
      this.#statements
        .get(
          "INSERT OR IGNORE INTO held_leases (workerId, leaseId, platform, source, at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(workerId, lease.leaseId, lease.platform, lease.source, lease.at),
    );
  }

  releaseLease(
    workerId: string,
    leaseId: string,
  ): { readonly platform: string; readonly at: number } | undefined {
    const held = this.#statements
      .get("SELECT platform, at FROM held_leases WHERE workerId = ? AND leaseId = ?")
      .get(workerId, leaseId);
    if (held === undefined) return undefined;
    this.#statements
      .get("DELETE FROM held_leases WHERE workerId = ? AND leaseId = ?")
      .run(workerId, leaseId);
    return { at: Number(held.at), platform: String(held.platform) };
  }

  waitingByPlatform(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of this.#statements
      .get(
        `SELECT platform, COUNT(*) AS n FROM request_rows WHERE ${OPEN} AND probe = 0 GROUP BY platform`,
      )
      .all()) {
      counts.set(String(row.platform), Number(row.n));
    }
    return counts;
  }

  heldByWorker(): Map<string, Map<string, number>> {
    const counts = new Map<string, Map<string, number>>();
    for (const row of this.#statements
      .get("SELECT workerId, platform, COUNT(*) AS n FROM held_leases GROUP BY workerId, platform")
      .all()) {
      const worker = String(row.workerId);
      const byPlatform = counts.get(worker) ?? new Map<string, number>();
      byPlatform.set(String(row.platform), Number(row.n));
      counts.set(worker, byPlatform);
    }
    return counts;
  }
}
