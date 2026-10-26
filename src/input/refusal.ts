function refusal(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

// why: a plain GET to the socket's path says what the path is for, so a person who opens it in a browser knows to open a socket.
export function upgradeRequired(): Response {
  return refusal(426, "BAD_REQUEST", "This path takes a WebSocket upgrade, not a plain request", {
    upgrade: "websocket",
  });
}

export function unknownLease(leaseId: string): Response {
  return refusal(404, "UNKNOWN_LEASE", `Unknown lease: ${leaseId}`);
}

export function unavailable(code: string, message: string): Response {
  return refusal(503, code, message);
}
