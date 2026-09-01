/**
 * Renders any thrown value as `<Error name>: <message>` -- the stable, human-readable summary
 * shared by every `component.install-*` / `device.purge-failed`-style diagnostic that reports
 * a caught error. Non-`Error` throws are wrapped first so every summary still has a name to
 * report. One definition shared by both driver modules and the core coordinators that need it,
 * rather than four copies drifting independently.
 */
export function stableError(error: unknown): string {
  const value = error instanceof Error ? error : new Error(String(error));
  return `${value.name}: ${value.message}`;
}
