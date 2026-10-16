import { methodName } from "./rpc.js";

const RPC_METHODS: ReadonlySet<string> = new Set([
  "command",
  "lease.allocate",
  "lease.heartbeat",
  "lease.release",
]);

export function isKnownRpcMethod(method: string): boolean {
  const name = methodName(method);
  return name !== undefined && RPC_METHODS.has(name);
}

const FIXED_ROUTES: ReadonlyMap<string, string> = new Map([
  ["/health", "GET"],
  ["/rpc", "POST"],
  ["/upload", "POST"],
  ["/upload/preflight", "POST"],
  ["/upload/finalize", "POST"],
  ["/artifacts", "GET"],
  ["/artifacts/", "GET"],
]);

export function isKnownRoute(method: string, path: string): boolean {
  if (FIXED_ROUTES.get(path) === method) return true;
  const segments = path.split("/").slice(1);
  if (segments.some((segment, index) => segment === "" && index < segments.length - 1)) {
    return false;
  }
  const [first, second, third, fourth, fifth] = segments;
  if (method === "PUT") {
    return first === "upload" && second === "direct" && segments.length === 3 && third !== "";
  }
  if (method !== "GET") return false;
  if (first === "artifacts") return segments.length >= 2 && segments.every((s) => s !== "");
  return (
    first === "sessions" &&
    segments.length === 5 &&
    second !== "" &&
    third === "requests" &&
    fourth !== "" &&
    fifth === "diagnostics"
  );
}
