/**
 * why: launchd_sim reads `disabled.plist` at boot, a flat XML property list mapping a launchd
 * label to `<true/>` (off) or `<false/>` (on); and `launchctl print-disabled system` prints the
 * state it holds. Both are tiny and flat, so they are read and written here rather than through
 * a plist library (ADR 0060 §1, §2).
 */

const ENTRY_PATTERN = /<key>([^<]*)<\/key>\s*<(true|false)\s*\/>/g;
const DICT_PATTERN = /<plist[^>]*>\s*<dict\s*(?:\/>|>([\s\S]*)<\/dict>)\s*<\/plist>/;
const PRINT_DISABLED_LINE = /^\s*"([^"]+)"\s*=>\s*(\S+)/;

export function parseOverridesPlist(text: string): Map<string, boolean> | undefined {
  const body = DICT_PATTERN.exec(text);
  if (body === null) return undefined;
  const inner = body[1] ?? "";
  if (inner.replace(ENTRY_PATTERN, "").trim() !== "") return undefined;
  const entries = new Map<string, boolean>();
  for (const match of inner.matchAll(ENTRY_PATTERN)) {
    entries.set(unescapeXml(match[1] ?? ""), match[2] === "true");
  }
  return entries;
}

export function renderOverridesPlist(entries: ReadonlyMap<string, boolean>): string {
  const lines = [...entries].map(
    ([label, disabled]) => `\t<key>${escapeXml(label)}</key>\n\t<${String(disabled)}/>`,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...lines,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function parsePrintDisabled(stdout: string): Map<string, boolean> {
  const entries = new Map<string, boolean>();
  for (const line of stdout.split("\n")) {
    const match = PRINT_DISABLED_LINE.exec(line);
    if (match?.[1] !== undefined) {
      entries.set(match[1], match[2] === "disabled" || match[2] === "true");
    }
  }
  return entries;
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function unescapeXml(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
