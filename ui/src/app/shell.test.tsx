import { describe, expect, it } from "vitest";

import type { DaemonFacts, DaemonMode } from "../data/mode";
import { inConsole } from "../state/test-support";
import { UpdateNotice } from "./shell";

function textOf(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text;
}

function footer(options: {
  readonly mode: DaemonMode | undefined;
  readonly daemon: DaemonFacts;
  readonly collapsed?: boolean;
}): string {
  return textOf(
    inConsole(<UpdateNotice collapsed={options.collapsed ?? false} />, {
      daemon: () => options.daemon,
      mode: () => options.mode,
    }),
  );
}

describe("the sidebar footer", () => {
  it("tells a gateway's operator its own latest version when it is newer, and nothing otherwise", () => {
    const cases = [
      {
        name: "newer",
        mode: "gateway",
        daemon: { version: "0.3.0", latestVersion: "0.4.0" },
        collapsed: false,
        shown: "simlock 0.3.0 · 0.4.0 available",
      },
      {
        name: "equal",
        mode: "gateway",
        daemon: { version: "0.4.0", latestVersion: "0.4.0" },
        collapsed: false,
        shown: "",
      },
      {
        name: "none known",
        mode: "gateway",
        daemon: { version: "0.3.0", latestVersion: null },
        collapsed: false,
        shown: "",
      },
      {
        name: "collapsed",
        mode: "gateway",
        daemon: { version: "0.3.0", latestVersion: "0.4.0" },
        collapsed: true,
        shown: "",
      },
      {
        name: "worker",
        mode: "worker",
        daemon: { version: "0.3.0", latestVersion: "0.4.0" },
        collapsed: false,
        shown: "",
      },
      {
        name: "mode unknown",
        mode: undefined,
        daemon: { version: "0.3.0", latestVersion: "0.4.0" },
        collapsed: false,
        shown: "",
      },
    ] as const;

    expect(cases.map((entry) => ({ name: entry.name, shown: footer(entry) }))).toEqual(
      cases.map((entry) => ({ name: entry.name, shown: entry.shown })),
    );
  });
});
