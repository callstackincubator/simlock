import { describe, expect, it } from "vitest";

import { consoleUrl } from "./console-url.js";

describe("consoleUrl", () => {
  it("consoleUrl shows localhost for an unspecified host and brackets an IPv6 host", () => {
    const at = (host: string) => consoleUrl({ enabled: true, host, port: 4700 });

    expect(at("0.0.0.0")).toBe("http://localhost:4700/");
    expect(at("::")).toBe("http://localhost:4700/");
    expect(at("::1")).toBe("http://[::1]:4700/");
    expect(at("fd7a:115c:a1e0::1")).toBe("http://[fd7a:115c:a1e0::1]:4700/");
    expect(at("127.0.0.1")).toBe("http://127.0.0.1:4700/");
    expect(at("mac-mini.tailnet.ts.net")).toBe("http://mac-mini.tailnet.ts.net:4700/");
  });

  it("is undefined when HTTP is disabled", () => {
    expect(consoleUrl({ enabled: false, host: "127.0.0.1", port: 4700 })).toBeUndefined();
  });
});
