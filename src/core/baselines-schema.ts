import type { SqliteSchemaOwner } from "../ports/index.js";

const BASELINES_V1 = `
CREATE TABLE baselines (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  platform TEXT NOT NULL,
  model TEXT NOT NULL,
  os_version TEXT NOT NULL,
  mode TEXT NOT NULL,
  image_tag TEXT,
  note TEXT,
  saved_at TEXT NOT NULL,
  source_id TEXT NOT NULL,
  stale_reason TEXT,
  PRIMARY KEY (name, version)
) STRICT;
`;

export const baselinesOwner: SqliteSchemaOwner = {
  migrations: [
    BASELINES_V1,
    "ALTER TABLE baselines ADD COLUMN backend TEXT NOT NULL DEFAULT 'local';",
  ],
  name: "baselines",
  version: 2,
};
