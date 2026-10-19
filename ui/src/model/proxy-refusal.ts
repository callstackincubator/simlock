const WHY: Readonly<Record<string, string>> = {
  algorithm: "it is signed in a way this daemon does not accept",
  "bad-signature": "its signature does not check out",
  expired: "it has expired",
  "keys-unavailable": "this daemon cannot reach the sign-in service's keys",
  malformed: "it is not a valid sign-in token",
  "not-yet-valid": "it is not valid yet; check this machine's clock",
  "unknown-key": "its signature does not check out",
  "wrong-audience": "it was made for a different application",
  "wrong-issuer": "it comes from a different sign-in service than this daemon expects",
};

export function proxyRefusalLine(reason: string): string {
  const why = Object.hasOwn(WHY, reason) ? WHY[reason] : "it was refused";
  return `Your sign-in proxy's identity was refused: ${why}. You can still sign in with an operator token.`;
}
