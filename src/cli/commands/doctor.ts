// why: findings a person must act on go to stderr and the report to stdout, so a piped report
// stays machine-readable while an operator at a terminal still sees what to do.
import type { DoctorReport } from "../../admin/index.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    fix: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    "purge-orphans": { type: "boolean" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock doctor [--fix] [--purge-orphans] [--yes]\n");
    return 0;
  }
  const purgeOrphans = values["purge-orphans"] === true;
  if (purgeOrphans) {
    const confirmed =
      values.yes ?? (await environment.confirm?.("Destroy every orphaned device? [y/N] "));
    if (!confirmed) throw new UsageError("doctor --purge-orphans requires confirmation or --yes");
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const response = await client.runDoctor({ fix: values.fix === true, purgeOrphans });
    writeDriverAdvisoryWarnings(environment, response);
    writeMissingPrerequisites(environment, response);
    writeUnreachableWarmTargets(environment, response);
    writeModuleUnavailable(environment, response);
    writeResult((value) => environment.stdout.write(value), response);
    return 0;
  } finally {
    await client.close();
  }
}

function writeDriverAdvisoryWarnings(
  environment: CommandContext["environment"],
  report: DoctorReport,
): void {
  for (const finding of report.findings) {
    if (finding.kind !== "driver-advisory") continue;
    environment.stderr.write(`Warning [${finding.platform}] ${finding.code}: ${finding.message}\n`);
  }
}

function writeMissingPrerequisites(
  environment: CommandContext["environment"],
  report: DoctorReport,
): void {
  for (const finding of report.findings) {
    if (finding.kind !== "prerequisite-missing") continue;
    environment.stderr.write(
      `Missing [${finding.platform}] ${finding.prerequisite}: ${finding.message} ${finding.remedy}\n`,
    );
  }
}

function writeUnreachableWarmTargets(
  environment: CommandContext["environment"],
  report: DoctorReport,
): void {
  for (const finding of report.findings) {
    if (finding.kind !== "warm-pool-target-unreachable") continue;
    environment.stderr.write(
      `${finding.kind}  ${finding.target}: ${finding.message}; ${finding.remedy}\n`,
    );
  }
}

function writeModuleUnavailable(
  environment: CommandContext["environment"],
  report: DoctorReport,
): void {
  const oneLine = (text: string): string => text.replace(/\s+/g, " ").slice(0, 500);
  for (const finding of report.findings) {
    if (finding.kind !== "module-unavailable") continue;
    environment.stderr.write(
      `${finding.module}  fail  ${oneLine(finding.message)}; ${oneLine(finding.remedy)}\n`,
    );
  }
}

export { run };
