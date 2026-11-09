import { expect, NAV_LABELS, openFromNav, signIn, startProxiedDaemon, test } from "./fixtures.js";

const OPERATOR_NEEDED = "That token is real, but the console needs an operator token.";

test.describe("sign-in", () => {
  test("an operator token signs in with its label, a reload keeps it, a new tab asks for a token, signing out is final, and the page asks no host but the daemon", async ({
    context,
    daemon,
    page,
  }) => {
    const minted = await daemon.cli([
      "token",
      "create",
      "--role",
      "operator",
      "--label",
      "ci-runner",
    ]);
    const origin = new URL(daemon.url).origin;
    const requested: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await signIn(page, (minted.json as { secret: string }).secret);

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByText("Signed in as ci-runner")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(nav.getByRole("link")).toHaveText([...NAV_LABELS]);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.locator(".connection")).toHaveText("Connected");
    for (const label of NAV_LABELS) {
      await openFromNav(page, label);
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    }

    await page.reload();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // why: every font the page uses has loaded by now, so a font request would have shown up.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const tab = await context.newPage();
    await tab.goto("/fleet");
    await expect(tab.getByLabel("Operator token")).toBeVisible();
    await expect(tab.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    await tab.close();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Operator token")).toBeVisible();

    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    expect(requested.some((url) => url.endsWith(".woff2"))).toBe(true);
    // why: a request the page's Content-Security-Policy refused never reaches the network, but the
    // browser reports it as an error; the load-time 401 from `/v1/identity` is the one error the
    // flow expects.
    expect(errors.filter((text) => !text.includes("401"))).toEqual([]);
  });

  test("the daemon refuses an agent token, a worker token and an unknown token with the console's messages", async ({
    daemon,
    page,
  }) => {
    await page.goto("/");

    await signIn(page, daemon.tokens.agent);
    await expect(page.getByRole("alert")).toHaveText(OPERATOR_NEEDED);
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    await signIn(page, daemon.tokens.worker);
    await expect(page.getByRole("alert")).toHaveText(OPERATOR_NEEDED);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);

    await signIn(page, "slk_not-a-token-this-daemon-issued");
    await expect(page.getByRole("alert")).toHaveText("This daemon does not know that token.");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });
});

test.describe("serving", () => {
  test("the address simlock status prints shows the sign-in screen on a single host and on a gateway, and the gateway's operator token signs in", async ({
    daemon,
    gateway,
    page,
  }) => {
    await page.goto(daemon.url);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Operator token")).toBeVisible();

    await page.goto(gateway.url);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await signIn(page, gateway.tokens.operator);

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});

test.describe("signing in through a proxy", () => {
  test("the console opens on Overview with no token form, reading who is signed in, a release from it succeeds, and the page asks no host but the proxy", async ({
    page,
  }) => {
    const proxied = await startProxiedDaemon({
      driverScript: { ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] } },
    });
    try {
      const granted = await proxied.daemon.cli([
        "lease",
        "--platform",
        "ios",
        "--device",
        "iPhone 16",
        "--os",
        "18.4",
        "--detach",
        "--agent-id",
        "proxy-agent",
      ]);
      expect(granted.code, granted.stderr).toBe(0);
      const origin = new URL(proxied.url).origin;
      const requested: string[] = [];
      const errors: string[] = [];
      const deletes: { status: number; site: string | undefined }[] = [];
      page.on("request", (request) => requested.push(request.url()));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", async (response) => {
        const request = response.request();
        if (request.method() === "DELETE") {
          deletes.push({
            site: (await request.allHeaders())["sec-fetch-site"],
            status: response.status(),
          });
        }
      });

      await page.goto(proxied.url);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await expect(page.getByLabel("Operator token")).toHaveCount(0);
      await expect(page.getByText("Signed in as Alice")).toBeVisible();

      await openFromNav(page, "Leases");
      const row = page.locator("main tbody tr").filter({ hasText: "proxy-agent" });
      await row.click();
      await page
        .getByRole("region", { exact: true, name: "Lease" })
        .getByRole("button", { exact: true, name: "Release" })
        .click();
      await page
        .getByRole("alertdialog", { name: "Release proxy-agent's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();

      await expect(page.getByText("Released proxy-agent's lease")).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(deletes).toEqual([{ site: "same-origin", status: 202 }]);
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
      // why: a request the page's Content-Security-Policy refused never reaches the network, but
      // the browser reports it as an error; the 404 of the released lease's details is the one
      // error the flow expects.
      expect(errors.filter((text) => !text.includes("404"))).toEqual([]);
    } finally {
      await proxied.dispose();
    }
  });

  test("the proxy's own session ending reloads the page onto the proxy's login page", async ({
    page,
  }) => {
    const proxied = await startProxiedDaemon();
    try {
      await page.goto(proxied.url);
      await expect(page.getByText("Signed in as Alice")).toBeVisible();

      proxied.endSession();
      // why: the console reads again when the operator returns to the tab, so the next request
      // comes at once.
      await page.evaluate(() => {
        const show = (state: "hidden" | "visible") => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => state,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        };
        show("hidden");
        show("visible");
      });

      await expect(page).toHaveURL(proxied.loginUrl);
      await expect(page.getByRole("heading", { name: "Proxy login" })).toBeVisible();
    } finally {
      await proxied.dispose();
    }
  });
});
