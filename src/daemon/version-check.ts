import { updateRequestedVersionSchema } from "../contract/index.js";
import type { Clock, Logger, NpmCli, TimerHandle } from "../ports/index.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface VersionCheck {
  latest(): string | null;
  dispose(): void;
}

export interface VersionCheckOptions {
  readonly npm: NpmCli;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly enabled: boolean;
}

export function startVersionCheck(options: VersionCheckOptions): VersionCheck {
  const { npm, clock, logger, enabled } = options;
  if (!enabled) return { latest: () => null, dispose: () => undefined };
  let latest: string | null = null;
  let timer: TimerHandle | undefined;
  let disposed = false;

  const check = async (): Promise<void> => {
    const viewed = await npm.view("simlock@latest").then(
      (outcome) => outcome,
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (disposed) return;
    const parsed = viewed.ok ? updateRequestedVersionSchema.safeParse(viewed.output.trim()) : null;
    if (parsed?.success === true) latest = parsed.data;
    else
      logger.warn("Latest Simlock version check failed", {
        message: viewed.ok ? "unreadable answer" : viewed.message,
      });
    timer = clock.setTimer(CHECK_INTERVAL_MS, () => void check());
  };
  void check();

  return {
    latest: () => latest,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clock.cancel(timer);
    },
  };
}
