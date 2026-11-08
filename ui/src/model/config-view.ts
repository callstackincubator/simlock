export interface ConfigEntry {
  readonly key: string;
  readonly value: string;
  // why: a secret the daemon masked; there is nothing true to copy for it.
  readonly masked: boolean;
}

export interface ConfigSection {
  readonly name: string;
  readonly entries: readonly ConfigEntry[];
}

// why: what `redactConfig` puts in place of a secret; the console shows it as the daemon sent it.
const MASKED = "[redacted]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaves(path: string, value: unknown, out: ConfigEntry[]): void {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    // why: an empty object is a value too (`capabilities.x: {}`), not nothing.
    if (keys.length === 0) out.push({ key: path, masked: false, value: "{}" });
    for (const key of keys) leaves(`${path}.${key}`, value[key], out);
    return;
  }
  // why: a list is set whole, as JSON, so it is one key.
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  out.push({ key: path, masked: text.includes(MASKED), value: text });
}

// why: the daemon's config is grouped by its top-level key, as the config file is; a scalar at the
// top (`mode`) forms a section of its own named by the key.
export function configSections(config: Record<string, unknown>): readonly ConfigSection[] {
  return Object.keys(config)
    .sort()
    .map((name) => {
      const entries: ConfigEntry[] = [];
      leaves(name, config[name], entries);
      return { entries, name };
    });
}

// why: the command to run on the daemon's machine; a value the shell would split or expand is quoted.
export function setCommand(key: string, value: string): string {
  const plain = /^[A-Za-z0-9_@%+=:,./-]+$/.test(value);
  return `simlock config set ${key} ${plain ? value : `'${value.replaceAll("'", "'\\''")}'`}`;
}
