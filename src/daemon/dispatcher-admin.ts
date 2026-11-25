import type { TokenOperations } from "../auth/index.js";
import { DispatchError } from "./dispatch.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";

export class DoctorUnavailableError extends Error {
  constructor() {
    super("Doctor is unavailable");
    this.name = "DoctorUnavailableError";
  }
}

export class NukeUnavailableError extends Error {
  constructor() {
    super("Nuke is unavailable");
    this.name = "NukeUnavailableError";
  }
}

export class AdminHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  readonly daemonUpdate: Handler<"daemon.update"> = async (input) => {
    const update = this.options.update;
    if (update === undefined) {
      throw new DispatchError("UNKNOWN_REQUEST", "This daemon does not update itself");
    }
    return {
      ...(await update.request(input)),
      version: this.options.version,
      health: this.options.health(),
    };
  };

  readonly doctorRun: Handler<"doctor.run"> = async (input) => {
    if (this.options.doctor === undefined) throw new DoctorUnavailableError();
    // why: `purgeOrphans` travels as its own flag all the way down, never folded into `fix`:
    // someone already running `doctor --fix` unattended in CI must not acquire a
    // destructive behaviour by upgrading (ADR 0001, decision 6).
    return this.options.doctor.reconcile({
      fix: input.fix ?? false,
      prerequisites: true,
      purgeOrphans: input.purgeOrphans ?? false,
    });
  };

  readonly cleanupRun: Handler<"cleanup.run"> = async (input) =>
    this.options.reaper.run({
      dryRun: input.dryRun ?? false,
      ...(input.rule === undefined ? {} : { rule: input.rule }),
    });

  readonly nukeRun: Handler<"nuke.run"> = async (input) => {
    if (this.options.nuke === undefined) throw new NukeUnavailableError();
    return this.options.nuke.run({
      deleteDevices: input.deleteDevices ?? false,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
  };

  readonly tokenCreate: Handler<"token.create"> = async (input) => {
    const { record, secret } = await requireTokens(this.options).create(input.role, input.label);
    return { secret, token: record };
  };

  readonly tokenList: Handler<"token.list"> = async () => ({
    tokens: await requireTokens(this.options).list(),
  });

  readonly tokenRevoke: Handler<"token.revoke"> = async (input) => {
    const revoked = await requireTokens(this.options).revoke(input.id);
    if (revoked) this.options.closeSessionsForToken?.(input.id);
    return { revoked };
  };
}

export function requireTokens(options: DispatcherOptions): TokenOperations {
  if (options.tokens === undefined) {
    throw new DispatchError("INTERNAL", "Token store is unavailable");
  }
  return options.tokens;
}
