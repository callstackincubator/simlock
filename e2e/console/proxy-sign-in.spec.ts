import { expect, NAV_LABELS, openFromNav, signIn, startProxiedDaemon, test } from "./fixtures.js";

const EXPIRED_LINE =
  "Your sign-in proxy's identity was refused: it has expired. You can still sign in with an operator token.";

test.describe("signing in through a proxy", () => {
  test("the console opens on Overview with no token form, reading who is signed in", async ({
    page,
    proxied,
  }) => {
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(proxied.url);

    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
    await expect(page.getByText("Signed in as Alice")).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Console" });
    await nav.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(page.getByText("Signed in as Alice")).toBeHidden();
    await expect(nav.getByRole("button", { name: "Sign out" })).toHaveAttribute(
      "title",
      "Sign out (Alice)",
    );
  });

  test("the page shows Signing in… and no token form while the identity answer is held", async ({
    page,
    proxied,
  }) => {
    const release = proxied.holdIdentity();
    await page.goto(proxied.url);

    await expect(page.getByText("Signing in…")).toBeVisible();
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
    release();

    await expect(page.getByText("Signed in as Alice")).toBeVisible();
  });

  test("Sign out goes to the proxy's sign-out address when one is set", async ({
    page,
    proxied,
  }) => {
    await page.goto(proxied.url);
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL(proxied.signedOutUrl);
    await expect(page.getByRole("heading", { name: "Signed out of the proxy" })).toBeVisible();
  });

  test("there is no Sign out button when no sign-out address is set", async ({ page }) => {
    const bare = await startProxiedDaemon({ signOutUrl: false });
    try {
      await page.goto(bare.url);

      await expect(page.getByText("Signed in as Alice")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
    } finally {
      await bare.dispose();
    }
  });

  test("an expired identity is said so on the token form, a labelled operator token opens the console, and its Sign out lands in the proxy session", async ({
    page,
    proxied,
  }) => {
    const minted = await proxied.daemon.cli([
      "token",
      "create",
      "--role",
      "operator",
      "--label",
      "ci-runner",
    ]);
    const secret = (minted.json as { secret: string }).secret;
    proxied.setMode("expired");
    await page.goto(proxied.url);

    await expect(page.getByRole("alert")).toHaveText(EXPIRED_LINE);
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await signIn(page, secret);

    await expect(page.getByText("Signed in as ci-runner")).toBeVisible();
    proxied.setMode("signed-in");
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.getByText("Signed in as Alice")).toBeVisible();
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
  });

  test("an identity that expires while signed in takes the next request to the token form with that line", async ({
    page,
    proxied,
  }) => {
    await page.goto(proxied.url);
    await expect(page.getByText("Signed in as Alice")).toBeVisible();

    // why: the console polls every second, so the next request can come before any click.
    proxied.setMode("expired");

    await expect(page.getByLabel("Operator token")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText(EXPIRED_LINE);
  });

  test("the proxy's own session ending reloads onto its login page, and a second ending within 60 seconds shows Your sign-in has ended.", async ({
    page,
    proxied,
  }) => {
    // why: the reload guard lives in sessionStorage, so each first ending starts in a fresh tab.
    const redirected = await page.context().newPage();
    await redirected.goto(proxied.url);
    await expect(redirected.getByText("Signed in as Alice")).toBeVisible();
    proxied.setMode("redirect");
    await expect(redirected).toHaveURL(proxied.loginUrl);
    await expect(redirected.getByRole("heading", { name: "Proxy login" })).toBeVisible();
    await redirected.close();

    proxied.setMode("signed-in");
    const reloaded = await page.context().newPage();
    await reloaded.goto(proxied.url);
    await expect(reloaded.getByText("Signed in as Alice")).toBeVisible();
    proxied.setMode("html");
    await expect(reloaded.getByRole("heading", { name: "Proxy sign-in" })).toBeVisible();

    proxied.setMode("signed-in");
    await reloaded.goto(proxied.url);
    await expect(reloaded.getByText("Signed in as Alice")).toBeVisible();
    await reloaded.evaluate(() => {
      (window as unknown as { loadedOnce: boolean }).loadedOnce = true;
    });
    proxied.setMode("html");

    await expect(reloaded.getByText("Your sign-in has ended.")).toBeVisible();
    await expect(reloaded.getByRole("button", { name: "Sign in again" })).toBeVisible();
    expect(
      await reloaded.evaluate(() => (window as unknown as { loadedOnce?: boolean }).loadedOnce),
    ).toBe(true);
  });

  test("revoking the token a person signed in with takes the console to the proxy session", async ({
    page,
    proxied,
  }) => {
    const minted = await proxied.daemon.cli(["token", "create", "--role", "operator"]);
    const { secret, token } = minted.json as { secret: string; token: { id: string } };
    proxied.setMode("expired");
    await page.goto(proxied.url);
    await signIn(page, secret);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    proxied.setMode("signed-in");

    expect((await proxied.daemon.cli(["token", "revoke", token.id])).code).toBe(0);
    await page.reload();

    await expect(page.getByText("Signed in as Alice")).toBeVisible();
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
  });

  test("the page makes no request to any host but the proxy's", async ({ page, proxied }) => {
    const origin = new URL(proxied.url).origin;
    const requested: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(proxied.url);
    for (const label of NAV_LABELS) {
      await openFromNav(page, label);
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    }
    // why: a request the page's Content-Security-Policy refused never reaches the network, but the
    // browser reports it as an error. Checked before the reload, which makes WebKit report the
    // requests it cuts off as errors too.
    expect(errors).toEqual([]);
    await page.reload();
    await expect(page.getByText("Signed in as Alice")).toBeVisible();

    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
  });

  test("signed in through the sign-in proxy, a release from the console succeeds", async ({
    page,
  }) => {
    const leasing = await startProxiedDaemon({
      driverScript: { ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] } },
    });
    try {
      const granted = await leasing.daemon.cli([
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
      const deletes: { status: number; site: string | undefined }[] = [];
      page.on("response", async (response) => {
        const request = response.request();
        if (request.method() === "DELETE") {
          deletes.push({
            site: (await request.allHeaders())["sec-fetch-site"],
            status: response.status(),
          });
        }
      });

      await page.goto(new URL("/leases", leasing.url).toString());
      await expect(page.getByText("Signed in as Alice")).toBeVisible();
      const row = page.locator("main tbody tr").filter({ hasText: "proxy-agent" });
      await row.getByRole("button", { name: "Actions for proxy-agent" }).click();
      await page.getByRole("menuitem", { name: "Release lease" }).click();
      await page
        .getByRole("alertdialog", { name: "Release proxy-agent's lease?" })
        .getByRole("button", { name: "Release lease" })
        .click();

      await expect(page.getByText("Released proxy-agent's lease")).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(deletes).toEqual([{ site: "same-origin", status: 202 }]);
    } finally {
      await leasing.dispose();
    }
  });
});
