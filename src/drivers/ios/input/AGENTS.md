# iOS device input

Does: taps, scrolls, Home and keys on an iOS simulator, through `simlock-screen-capture <udid> --input`; a physical iPhone answers unavailable.
Entry: `index.ts` → `createIosDeviceInput(options)`, built by `IosSimctlDriver` as its `input` whenever it has a `screenCapture`. It is the implementation of core's `DeviceInputFactory` (`core/input.ts`).
Uses: core (`DeviceInput`, `InputMessage`, the screen envelope), ports (`BytePipeLauncher`, `Clock`, `Logger`, `ProcessRunner`), `../runtime-version.ts`, `../screen-capture.ts` (`stopProgram`). Parent: [iOS driver](../AGENTS.md). Consumer: [input](../../../input/AGENTS.md).

## Files

| File              | Role                                        |
| ----------------- | ------------------------------------------- |
| `index.ts`        | `createIosDeviceInput`, entered only here   |
| `device-input.ts` | One input: open, send, Home, failure, close |

## How it works

The wire, the 10 s ready limit, Home, the dropped buttons and keys, and close are described under "Input" in the [iOS driver manual](../AGENTS.md).

## Rules

- The helper's HID client and the runtime rule for keys stay here; core and the input module name neither.
- Home is `xcrun simctl` here and nowhere in the helper (one owner).
