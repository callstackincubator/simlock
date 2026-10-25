import type { SqliteSchemaOwner } from "../ports/index.js";

const REGISTRY_V1 = `
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  physical INTEGER NOT NULL,
  driver_device_id TEXT NOT NULL,
  state TEXT NOT NULL,
  model TEXT NOT NULL,
  os_version TEXT NOT NULL,
  spec_mode TEXT,
  image_tag TEXT,
  class TEXT,
  mode TEXT,
  lease_identity TEXT,
  created_at INTEGER NOT NULL,
  last_lease_ended_at INTEGER,
  ready_at INTEGER,
  shutdown_at INTEGER,
  foreign_state_detected_at INTEGER,
  foreign_provenance_detected_at INTEGER,
  recovering_since INTEGER,
  recovery_attempts INTEGER,
  deferred_reclaim_lease_id TEXT,
  quarantined_at INTEGER,
  quarantine_attempts INTEGER,
  quarantine_next_retry_at REAL,
  quarantine_cause_kind TEXT,
  quarantine_cause_stalled_state TEXT,
  quarantine_cause_message TEXT,
  address TEXT,
  reclaiming_since INTEGER,
  absent_reason TEXT
) STRICT;

CREATE TABLE device_enrolled_apps (
  device_id TEXT NOT NULL REFERENCES devices (id),
  position INTEGER NOT NULL,
  app TEXT NOT NULL,
  PRIMARY KEY (device_id, position)
) STRICT;

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  ttl_ms REAL NOT NULL,
  ttl_deadline REAL NOT NULL,
  last_renewed_at INTEGER NOT NULL,
  id_chosen_by_requester INTEGER NOT NULL
) STRICT;

CREATE TABLE lease_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT,
  lease_id TEXT,
  fleet_request_id TEXT,
  platform TEXT NOT NULL,
  model TEXT,
  os_version TEXT,
  mode TEXT,
  image_tag TEXT,
  class TEXT,
  physical INTEGER,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  settled_at INTEGER,
  failure_code TEXT,
  failure_message TEXT
) STRICT;

CREATE TABLE lease_grants (
  request_id TEXT PRIMARY KEY REFERENCES lease_requests (id),
  device_id TEXT NOT NULL REFERENCES devices (id),
  lease_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  ttl_ms REAL NOT NULL,
  ttl_deadline REAL NOT NULL,
  last_renewed_at INTEGER NOT NULL,
  id_chosen_by_requester INTEGER NOT NULL,
  estimated_provision_ms INTEGER NOT NULL,
  estimated_boot_ms INTEGER NOT NULL,
  estimated_reclaim_ms INTEGER NOT NULL,
  estimated_ready_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE lease_grant_environment (
  request_id TEXT NOT NULL REFERENCES lease_grants (request_id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (request_id, name)
) STRICT;

CREATE TABLE components (
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (platform, version)
) STRICT;

CREATE TABLE component_receipt (
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (platform, version, key),
  FOREIGN KEY (platform, version) REFERENCES components (platform, version)
) STRICT;
`;

export const registryOwner: SqliteSchemaOwner = {
  migrations: [REGISTRY_V1],
  name: "registry",
  version: 1,
};
