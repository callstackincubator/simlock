/** Placeholder until the red tests are green: builds nothing. */
export function createCore(_options: unknown): {
  readonly nuke: { nuke(deleteDevices: boolean): Promise<unknown> };
} {
  throw new Error("createCore is not built yet");
}
