import type { ProcessRunner } from "./process-runner.js";

export interface AccessEntry {
  readonly sid: string;
  readonly name: string;
  readonly allow: boolean;
  /** why: the `FileSystemRights` mask of the entry, as Windows stores it. */
  readonly rights: number;
}

export interface DirectoryAccess {
  /** why: the SID of the account the process runs as; SIDs, since account names are localized. */
  readonly user: string;
  readonly entries: readonly AccessEntry[];
}

/** why: who can open a directory on Windows, where Node's mode bits are made up from the read-only attribute and say nothing about it. */
export interface DirectoryAccessReader {
  read(path: string): Promise<DirectoryAccess>;
}

const READ_TIMEOUT_MS = 10_000;
const PATH_VARIABLE = "SIMLOCK_ACL_PATH";
// why: generic rights set the top bit, so the signed mask is widened and masked back to the unsigned value.
// why: the path travels in the environment, so no quoting of it can break out of the script.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  `$acl = Get-Acl -LiteralPath $env:${PATH_VARIABLE}`,
  "$entries = @($acl.Access | ForEach-Object { [ordered]@{",
  "  sid = $_.IdentityReference.Translate($sid).Value;",
  "  name = $_.IdentityReference.Value;",
  "  allow = ($_.AccessControlType -eq 'Allow');",
  "  rights = ([int64][int]$_.FileSystemRights) -band 4294967295 } })",
  "[ordered]@{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; entries = $entries } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

export class PowerShellDirectoryAccessReader implements DirectoryAccessReader {
  constructor(private readonly processRunner: ProcessRunner) {}

  async read(path: string): Promise<DirectoryAccess> {
    const result = await this.processRunner.run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { timeoutMs: READ_TIMEOUT_MS, env: { ...process.env, [PATH_VARIABLE]: path } },
    );
    if (result.code !== 0) {
      throw new Error(`powershell exited ${String(result.code ?? result.endedBy)}`);
    }
    return parseDirectoryAccess(result.stdout);
  }
}

function parseDirectoryAccess(output: string): DirectoryAccess {
  const parsed = JSON.parse(output) as { user?: unknown; entries?: unknown };
  if (typeof parsed.user !== "string" || !Array.isArray(parsed.entries)) {
    throw new Error("unexpected ACL output");
  }
  const entries = parsed.entries.map((entry: Record<string, unknown>): AccessEntry => {
    const { sid, name, allow, rights } = entry;
    if (
      typeof sid !== "string" ||
      typeof name !== "string" ||
      typeof allow !== "boolean" ||
      typeof rights !== "number"
    ) {
      throw new Error("unexpected ACL entry");
    }
    return { sid, name, allow, rights };
  });
  return { user: parsed.user, entries };
}

export class FakeDirectoryAccessReader implements DirectoryAccessReader {
  readonly reads: string[] = [];

  constructor(private readonly access: DirectoryAccess | Error) {}

  read(path: string): Promise<DirectoryAccess> {
    this.reads.push(path);
    return this.access instanceof Error
      ? Promise.reject(this.access)
      : Promise.resolve(this.access);
  }
}
