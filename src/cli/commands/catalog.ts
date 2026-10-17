import { deviceClassSchema } from "../../contract/index.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import type { CatalogGetOutput } from "../../admin/index.js";
import type { CommandContext } from "../tree.js";

const DEVICE_CLASS_ORDER: readonly string[] = deviceClassSchema.options;

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    platform: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock catalog [--platform <ios|android>] [--json]\n");
    return 0;
  }
  if (values.platform !== undefined && values.platform !== "ios" && values.platform !== "android")
    throw new UsageError("catalog --platform must be ios or android");
  const platform = values.platform as "ios" | "android" | undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    const response = await client.getCatalog(platform === undefined ? {} : { platform });
    if (values.json) writeResult((value) => environment.stdout.write(value), response);
    else environment.stdout.write(`${formatCatalog(response)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

function formatCatalog(response: CatalogGetOutput): string {
  if (response.platforms.length === 0) return "No platforms available.";
  return response.platforms
    .map((entry) => {
      const defaultRuntime = entry.defaultRuntime ?? "(none)";
      const custom = new Set(entry.customModels ?? []);
      const modelLine = (model: string): string[] => {
        const paired =
          (Object.hasOwn(entry.modelRuntimes, model) ? entry.modelRuntimes[model] : undefined) ??
          [];
        const aliases =
          (Object.hasOwn(entry.modelAliases, model) ? entry.modelAliases[model] : undefined) ?? [];
        return [
          `      ${model}${custom.has(model) ? " (custom)" : ""}: ${paired.length > 0 ? paired.join(", ") : "(no paired runtime)"}`,
          ...(aliases.length > 0 ? [`        Other names: ${aliases.join(", ")}`] : []),
        ];
      };
      const classOf = (model: string): string | undefined =>
        Object.hasOwn(entry.modelClasses, model) ? entry.modelClasses[model] : undefined;
      const classLine = (deviceClass: string | undefined): string => {
        if (deviceClass === undefined) return "    (no class):";
        const model = Object.hasOwn(entry.classDefaults, deviceClass)
          ? entry.classDefaults[deviceClass as keyof typeof entry.classDefaults]
          : undefined;
        return `    ${deviceClass} (default: ${model ?? "none"}):`;
      };
      const models = [...DEVICE_CLASS_ORDER, undefined].flatMap((deviceClass) => {
        const members = entry.models.filter((model) => classOf(model) === deviceClass);
        return members.length === 0 ? [] : [classLine(deviceClass), ...members.flatMap(modelLine)];
      });
      const images = (entry.images ?? []).map(
        (image) => `    ${image.runtime} ${image.tag} ${image.abi}`,
      );
      return [
        `Platform: ${entry.platform}`,
        `  Runtimes: ${entry.runtimes.length > 0 ? entry.runtimes.join(", ") : "(none)"} (default: ${defaultRuntime})`,
        models.length > 0 ? "  Models:" : "  Models: (none)",
        ...models,
        ...(entry.images === undefined
          ? []
          : [images.length > 0 ? "  Images (runtime, tag, ABI):" : "  Images: (none)", ...images]),
      ].join("\n");
    })
    .join("\n");
}

export { run };
