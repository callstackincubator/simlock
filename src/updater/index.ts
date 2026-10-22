import type {
  Clock,
  DaemonRole,
  Filesystem,
  NpmCli,
  ProcessRunner,
  ProcessSupervisor,
} from "../ports/index.js";

export interface DaemonProbe {
  stop(): Promise<void>;
  answers(): Promise<boolean>;
  state(): Promise<{ readonly health: string; readonly version: string } | undefined>;
}

export interface RunUpdaterOptions {
  readonly from: string;
  readonly to: string;
  readonly role: DaemonRole;
  readonly pid: number;
  readonly npm: NpmCli;
  readonly probe: DaemonProbe;
  readonly processes: ProcessRunner;
  readonly supervisor: ProcessSupervisor;
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly packageRoot: string;
  readonly dataDirectory: string;
  readonly stdout: { write(chunk: string): void };
}

export async function runUpdater(_options: RunUpdaterOptions): Promise<number> {
  return 1;
}
