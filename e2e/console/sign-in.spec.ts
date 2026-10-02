import { expect, NAV_LABELS, signIn, test } from "./fixtures.js";

const OPERATOR_NEEDED = "That token is real, but the console needs an operator token.";

test.describe("sign-in", () => {
  test("an operator token signs in and shows the shell", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Console" });
    await expect(nav.getByRole("link")).toHaveText([...NAV_LABELS]);
    await expect(page).toHaveURL(/\/workers$/);
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
    await expect(page.getByText("Coming soon.")).toBeVisible();
    await expect(page.getByLabel("Operator token")).toHaveCount(0);
  });

  test("the navigation marks the current page, and the tab's title names it", async ({
    daemon,
    page,
  }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    const nav = page.getByRole("navigation", { name: "Console" });

    await expect(nav.locator("[aria-current='page']")).toHaveText("Workers");
    await expect(page).toHaveTitle("Workers · Simlock");
    await nav.getByRole("link", { name: "Events" }).click();

    await expect(nav.locator("[aria-current='page']")).toHaveText("Events");
    await expect(page).toHaveTitle("Events · Simlock");
  });

  test("a token pasted with spaces around it signs in", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, `  ${daemon.tokens.operator}\n`);

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("a revoked token is signed out on the next reload", async ({ daemon, page }) => {
    const minted = await daemon.cli(["token", "create", "--role", "operator"]);
    const { secret, token } = minted.json as { secret: string; token: { id: string } };
    await page.goto("/");
    await signIn(page, secret);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    expect((await daemon.cli(["token", "revoke", token.id])).code).toBe(0);
    await page.reload();

    await expect(page.getByLabel("Operator token")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("an agent token is refused with a message that the console needs an operator token", async ({
    daemon,
    page,
  }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.agent);

    await expect(page.getByRole("alert")).toHaveText(OPERATOR_NEEDED);
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("a worker token is refused with the same message", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.worker);

    await expect(page.getByRole("alert")).toHaveText(OPERATOR_NEEDED);
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("an unknown token is refused", async ({ page }) => {
    await page.goto("/");
    await signIn(page, "slk_not-a-token-this-daemon-issued");

    await expect(page.getByRole("alert")).toHaveText("This daemon does not know that token.");
    await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("a reload keeps the operator signed in", async ({ daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    await page.getByRole("link", { name: "Leases" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/leases$/);
    await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("a new tab asks for a token", async ({ context, daemon, page }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    const tab = await context.newPage();
    await tab.goto("/workers");

    await expect(tab.getByLabel("Operator token")).toBeVisible();
    await expect(tab.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  });

  test("signing out returns to the sign-in screen, and a reload does not sign back in", async ({
    daemon,
    page,
  }) => {
    await page.goto("/");
    await signIn(page, daemon.tokens.operator);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Operator token")).toBeVisible();
    await page.reload();

    await expect(page.getByLabel("Operator token")).toBeVisible();
  });

  test("the page makes no request to any host but the daemon", async ({ daemon, page }) => {
    const origin = new URL(daemon.url).origin;
    const requested: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");
    await signIn(page, daemon.tokens.agent);
    await expect(page.getByRole("alert")).toBeVisible();
    await signIn(page, daemon.tokens.operator);
    for (const label of NAV_LABELS) {
      await page.getByRole("link", { name: label }).click();
      await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
    }
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Every font the page uses has loaded, so a font request would have shown up by now.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => new URL(url).origin !== origin)).toEqual([]);
    expect(requested.some((url) => url.endsWith(".woff2"))).toBe(true);
    // A request the page's Content-Security-Policy refused never reaches the network, but the
    // browser reports it as an error; an agent token's 403 is the one error the flow expects.
    expect(errors.filter((text) => !text.includes("403"))).toEqual([]);
  });
});

test.describe("serving", () => {
  test("the address simlock status prints on a single host shows the sign-in screen", async ({
    daemon,
    page,
  }) => {
    await page.goto(daemon.url);

    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Operator token")).toBeVisible();
  });

  test("the address simlock status prints on a gateway shows the sign-in screen, and its operator token signs in", async ({
    gateway,
    page,
  }) => {
    await page.goto(gateway.url);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

    await signIn(page, gateway.tokens.agent);
    await expect(page.getByRole("alert")).toHaveText(OPERATOR_NEEDED);
    await signIn(page, gateway.tokens.operator);

    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
