export type Section = "/workers" | "/leases" | "/waiting" | "/attention" | "/events";

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
