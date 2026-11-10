export function cloudOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && local);
  const originOnly = isOriginOnly(url);
  if (secure === false || originOnly === false) {
    throw new Error("AgentDeviceCloud URL must be an HTTPS origin, or HTTP on localhost");
  }
  return url.origin;
}

function isOriginOnly(url: URL): boolean {
  return (
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname === "/"
  );
}
