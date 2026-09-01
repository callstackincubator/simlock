/**
 * Diagnostic shape both drivers report through their own `onDiagnostic` callback when a
 * platform component (an iOS runtime, an Android system image) installs. Deliberately neutral
 * -- nothing here references simctl or avdmanager concepts (architecture rule 2), so both
 * driver modules can depend on it without depending on each other.
 *
 * Drivers never touch the event bus directly (architecture rule 5: "loose coupling via the bus
 * is for observers only" -- a driver is not an observer of its own facts). The daemon layer
 * bridges this diagnostic to the `component.install-*` bus events at driver construction time
 * -- see `emitComponentInstallDiagnostic` in `src/daemon/main.ts`.
 */
export type ComponentInstallDiagnostic =
  | { readonly kind: "component-install-started"; readonly componentId: string }
  | {
      readonly kind: "component-installed";
      readonly componentId: string;
      readonly durationMs: number;
    }
  | {
      readonly kind: "component-install-failed";
      readonly componentId: string;
      readonly durationMs: number;
      readonly error: string;
    };
