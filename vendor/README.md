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
