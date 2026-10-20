export type Section = "/fleet" | "/leases" | "/queue" | "/attention" | "/activity";

export function itemPath(section: Section, id: string): `/${string}` {
  return `${section}/${encodeURIComponent(id)}`;
}

// why: ids are opaque and may hold a slash (an attention item's key does), so the whole rest of the
// path is one id; a malformed escape is kept as typed rather than thrown.
export function itemIdFrom(section: Section, path: string): string | undefined {
  if (!path.startsWith(`${section}/`)) return undefined;
  const rest = path.slice(section.length + 1).replace(/\/$/, "");
  if (rest === "") return undefined;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

export interface FleetAddress {
  readonly workerId?: string;
}

// why: a worker's page is `/fleet/<workerId>`, the id encoded, so a slash inside an id cannot be
// taken for a path separator; a malformed escape is kept as typed.
export function fleetAddress(path: string): FleetAddress {
  if (!path.startsWith("/fleet/")) return {};
  const [worker] = path.slice("/fleet/".length).replace(/\/$/, "").split("/");
  if (worker === undefined || worker === "") return {};
  try {
    return { workerId: decodeURIComponent(worker) };
  } catch {
    return { workerId: worker };
  }
}
