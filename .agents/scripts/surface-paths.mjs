// The paths a change may not touch without a person reading it: the surface files
// docs-surface-check.mjs lists (the command tree, the config, the error table, the MCP tools, the
// HTTP sources, the client exports, the event map), the wire protocol's version and the ADRs. The
// fast track holds a bug fix that touches one (delivery rule 17), and a refactor that touches one
// is not a refactor (delivery rule 18). `surfaceHits(paths)` is one `{ what, path }` per kind hit.
export const SURFACE_PATHS = [
  [
    "a surface file",
    /^src\/(?:cli\/tree|core\/config|contract\/errors|mcp\/(?:server|contracts)|(?:client|admin)\/index|bus\/index)\.ts$/,
  ],
  ["a surface file", /^src\/http\/(?!.*\.test\.ts$)[^/]+\.ts$/],
  ["the protocol version", /^src\/contract\/protocol\.ts$/],
  ["an ADR", /^docs\/internal\/adr\//],
];

export function surfaceHits(paths) {
  const hits = [];
  for (const [what, pattern] of SURFACE_PATHS) {
    const path = paths.find((p) => pattern.test(p));
    if (path !== undefined) hits.push({ what, path });
  }
  return hits;
}
