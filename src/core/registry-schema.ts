import type { SqliteSchemaOwner } from "../ports/index.js";

export const registryOwner: SqliteSchemaOwner = { migrations: [], name: "registry", version: 0 };
