# vendor

`agent-device-proxy-0.21.28-dev-253dca0.tgz` is `@agent-device/proxy`, packed
from the `simlock-integration` branch of agent-device at commit
`253dca023edf13410f7928c76e9e604e5e5871a0`:

```bash
pnpm --filter @agent-device/proxy pack --pack-destination <dir>
```

Its `prepack` runs the package's own build, which bundles agent-device's
internal packages into `dist`, so the tarball has no `workspace:` dependency.
It is swapped for the npm release later.

The commit above is the one the slow lane checks a local agent-device checkout
against, so it stays the first 40-character commit hash in this file:
`scripts/slow-e2e.sh` reads the first one it finds.

## What else lives here

| Directory | Upstream | License | Notice |
| --- | --- | --- | --- |
| `screen-capture/` | `EvanBacon/serve-sim` — a capture and encode pipeline we patched | Apache-2.0 | [`screen-capture/NOTICE.md`](screen-capture/NOTICE.md) |
| `scrcpy/` | `Genymobile/scrcpy` — the server artifact, byte-identical, not yet consumed | Apache-2.0 | [`scrcpy/NOTICE.md`](scrcpy/NOTICE.md) |

A first-level directory here is third-party or derived-from-third-party code, and
it holds the artifact(s), the license text(s) they require in `LICENSES/`, and a
`NOTICE.md`: upstream and author, the exact commit or release, what was taken and
what was left out, every deviation and why, the command that re-verifies it all
against upstream, and — per file, because a directory here can hold our code
beside theirs — which files are ours. `src/source-hygiene.test.ts` enforces
the three-part shape, and the rules are
[`docs/internal/agent-rules/vendor-and-third-party-code.md`](../docs/internal/agent-rules/vendor-and-third-party-code.md);
the whole inventory, including this tarball, is
[`docs/internal/VENDORED-CODE.md`](../docs/internal/VENDORED-CODE.md).

Nothing under the directories above is downloaded at install, at build or at run
time — they are in the tree because somebody fetched and checked them once.
