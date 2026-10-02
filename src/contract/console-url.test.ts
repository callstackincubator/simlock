import { describe, expect, it } from "vitest";

import { CONSOLE_URL_MAX_LENGTH, consoleUrl, consoleUrlField } from "./console-url.js";
import { OPERATIONS } from "./operations.js";

describe("consoleUrl", () => {
  it("consoleUrl shows localhost for an unspecified host and brackets an IPv6 host", () => {
    const at = (host: string) => consoleUrl({ enabled: true, host, port: 4700 });

    expect(at("0.0.0.0")).toBe("http://localhost:4700/");
    expect(at("::")).toBe("http://localhost:4700/");
    expect(at("::1")).toBe("http://[::1]:4700/");
    expect(at("fd7a:115c:a1e0::1")).toBe("http://[fd7a:115c:a1e0::1]:4700/");
    // Written already bracketed, it is not bracketed twice.
    expect(at("[::1]")).toBe("http://[::1]:4700/");
    expect(at("127.0.0.1")).toBe("http://127.0.0.1:4700/");
    expect(at("mac-mini.tailnet.ts.net")).toBe("http://mac-mini.tailnet.ts.net:4700/");
  });

  it("is undefined when HTTP is disabled", () => {
    expect(consoleUrl({ enabled: false, host: "127.0.0.1", port: 4700 })).toBeUndefined();
  });
});

describe("consoleUrlField", () => {
  it("leaves out an address over status.get's bound, which the wire refuses", () => {
    const longest = "a".repeat(CONSOLE_URL_MAX_LENGTH - "http://:4700/".length);
    const fits = consoleUrlField({ enabled: true, host: longest, port: 4700 });
    const over = consoleUrlField({ enabled: true, host: `${longest}a`, port: 4700 });
    const daemonBlock = OPERATIONS["status.get"].output.shape.daemon;

    expect(fits.consoleUrl).toHaveLength(CONSOLE_URL_MAX_LENGTH);
    expect(over).toEqual({});
    expect(
      daemonBlock.safeParse({
        health: "running",
        mode: "worker",
        consoleUrl: `${fits.consoleUrl}x`,
      }).success,
    ).toBe(false);
  });
});
