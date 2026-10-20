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
  readonly deviceId?: string;
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// why: a worker's page is `/fleet/<workerId>` and its device drawer `/fleet/<workerId>/<deviceId>`,
// each id encoded on its own, so a slash inside an id cannot be taken for the separator; a malformed
// escape is kept as typed.
export function fleetAddress(path: string): FleetAddress {
  if (!path.startsWith("/fleet/")) return {};
  const [worker, device] = path.slice("/fleet/".length).replace(/\/$/, "").split("/");
  if (worker === undefined || worker === "") return {};
  return device === undefined || device === ""
    ? { workerId: decoded(worker) }
    : { deviceId: decoded(device), workerId: decoded(worker) };
}

export function devicePath(workerId: string, deviceId: string): `/${string}` {
  return `/fleet/${encodeURIComponent(workerId)}/${encodeURIComponent(deviceId)}`;
}
