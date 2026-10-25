import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { e2eFakeDeviceDataTable } from "../fake-driver/device-data.js";
import type { TestEnv } from "./env.js";

const PHYSICAL_COLUMNS = {
  absentReason: "absent_reason",
  address: "address",
  class: "class",
  createdAt: "created_at",
  deferredReclaimLeaseId: "deferred_reclaim_lease_id",
  driverDeviceId: "driver_device_id",
  foreignProvenanceDetectedAt: "foreign_provenance_detected_at",
  foreignStateDetectedAt: "foreign_state_detected_at",
  lastLeaseEndedAt: "last_lease_ended_at",
  model: "model",
  osVersion: "os_version",
  quarantineAttempts: "quarantine_attempts",
  quarantineCauseKind: "quarantine_cause_kind",
  quarantineCauseMessage: "quarantine_cause_message",
  quarantineCauseStalledState: "quarantine_cause_stalled_state",
  quarantineNextRetryAt: "quarantine_next_retry_at",
  quarantinedAt: "quarantined_at",
  readyAt: "ready_at",
  reclaimingSince: "reclaiming_since",
  recoveringSince: "recovering_since",
  recoveryAttempts: "recovery_attempts",
  shutdownAt: "shutdown_at",
  state: "state",
} as const;

export async function openSeedDatabase(env: Pick<TestEnv, "home">) {
  const { openStateDatabase } = await import("../../dist/state/index.js");
  const { NoopLogger, NodeFilesystem, NodeSqliteOpener } =
    await import("../../dist/ports/index.js");
  const { registryOwner } = await import("../../dist/core/index.js");
  return openStateDatabase({
    dataDirectory: env.home,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    oldFiles: [],
    owners: [registryOwner, e2eFakeDeviceDataTable],
    sqlite: new NodeSqliteOpener(),
    upgradeStep: "",
  });
}

function withDatabase<T>(env: Pick<TestEnv, "home">, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(join(env.home, "state.db"));
  try {
    database.exec("PRAGMA busy_timeout=5000");
    return work(database);
  } finally {
    database.close();
  }
}

export function readPhysicalRecords(env: Pick<TestEnv, "home">): Record<string, unknown>[] {
  return withDatabase(env, (database) => {
    const rows = database.prepare("SELECT * FROM devices WHERE physical = 1 ORDER BY id").all();
    return rows.map((row) => {
      const record: Record<string, unknown> = { id: row["id"], physical: true };
      for (const [key, column] of Object.entries(PHYSICAL_COLUMNS)) {
        if (row[column] !== null && row[column] !== undefined) record[key] = row[column];
      }
      record["enrolledApps"] = database
        .prepare("SELECT app FROM device_enrolled_apps WHERE device_id = ? ORDER BY position")
        .all(String(row["id"]))
        .map((app) => app["app"]);
      return record;
    });
  });
}

export function patchPhysicalRows(
  env: Pick<TestEnv, "home">,
  patch: (record: Record<string, unknown>) => Record<string, unknown>,
): void {
  const records = readPhysicalRecords(env);
  withDatabase(env, (database) => {
    database.exec("BEGIN IMMEDIATE");
    for (const record of records) {
      const patched = patch(record);
      const assignments = Object.entries(PHYSICAL_COLUMNS).map(([, column]) => `${column} = ?`);
      const values = Object.keys(PHYSICAL_COLUMNS).map((key) => {
        const value = patched[key];
        return value === undefined ? null : (value as string | number);
      });
      database
        .prepare(`UPDATE devices SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, String(record["id"]));
      database
        .prepare("DELETE FROM device_enrolled_apps WHERE device_id = ?")
        .run(String(record["id"]));
      const apps = (patched["enrolledApps"] as readonly string[] | undefined) ?? [];
      apps.forEach((app, position) => {
        database
          .prepare("INSERT INTO device_enrolled_apps (device_id, position, app) VALUES (?, ?, ?)")
          .run(String(record["id"]), position, app);
      });
    }
    database.exec("COMMIT");
  });
}

export function readEnrolledApps(env: Pick<TestEnv, "home">): string[][] {
  return readPhysicalRecords(env).map((record) => record["enrolledApps"] as string[]);
}
