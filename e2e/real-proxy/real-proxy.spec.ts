import { expect, test, type Page } from "@playwright/test";

import { ALICE, ISSUER, PROXY_URL, startGateway, startWorker, type LaneDaemon } from "./lane.js";

let gateway: LaneDaemon;

test.beforeAll(async () => {
  gateway = await startGateway();
});

test.afterAll(async () => {
  await gateway.dispose();
});

async function logInAsAlice(page: Page): Promise<void> {
  await page.goto(`${PROXY_URL}/`);
  await page.locator("#login").fill(ALICE.email);
  await page.locator("#password").fill(ALICE.password);
  await page.locator("#submit-login").click();
}

async function identity(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => (await fetch("/v1/identity")).json());
}

test.describe("behind a real sign-in proxy", () => {
  test("opening the console through oauth2-proxy lands on Dex's login page; after logging in as Alice the console opens reading Signed in as Alice", async ({
    page,
  }) => {
    await page.goto(`${PROXY_URL}/`);
    await expect(page).toHaveURL(new RegExp(`^${ISSUER}/auth`));
    await expect(page.locator("#login")).toBeVisible();

    await logInAsAlice(page);

    await expect(page).toHaveURL(`${PROXY_URL}/`);
    await expect(page.getByText("Signed in as Alice", { exact: true })).toBeVisible();
  });

  test("after that login, GET /v1/identity from the page answers a proxy principal at Dex, Alice's name, via proxy and role admin", async ({
    page,
  }) => {
    await logInAsAlice(page);
    await expect(page.getByText("Signed in as Alice", { exact: true })).toBeVisible();

    const body = await identity(page);

    expect(body["principal"]).toMatch(/^proxy:http:\/\/127\.0\.0\.1:5556\/dex#.+/);
    expect(body["name"]).toBe("Alice");
    expect(body["via"]).toBe("proxy");
    expect(body["role"]).toBe("admin");
  });

  test("a worker with gateway.url ws://127.0.0.1:4180 joins through /v1/uplink and appears on the console's Workers page", async ({
    page,
  }) => {
    const minted = await gateway.cli(["token", "create", "--role", "worker"]);
    expect(minted.code, minted.stderr).toBe(0);
    const token = (minted.json as { secret: string }).secret;
    const worker = await startWorker({ gatewayUrl: "ws://127.0.0.1:4180", token });
    try {
      await logInAsAlice(page);
      await page.getByRole("link", { name: "Workers", exact: true }).click();

      await expect(
        page.getByRole("list", { name: "Workers", exact: true }).getByRole("listitem"),
      ).toHaveCount(1);
    } finally {
      await worker.dispose();
    }
  });

  test("GET /v1/identity through oauth2-proxy with no session and Accept text/html gets oauth2-proxy's redirect to Dex, never Simlock's answer", async () => {
    const answer = await fetch(`${PROXY_URL}/v1/identity`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });

    expect(answer.status).toBeGreaterThanOrEqual(300);
    expect(answer.status).toBeLessThan(400);
    expect(answer.headers.get("location")).toContain(`${ISSUER}/auth`);
  });

  test("signed in as Alice, a request through oauth2-proxy carrying a minted agent token answers GET /v1/identity as that token", async ({
    page,
  }) => {
    const minted = await gateway.cli(["token", "create", "--role", "agent", "--label", "ci-agent"]);
    expect(minted.code, minted.stderr).toBe(0);
    const secret = (minted.json as { secret: string }).secret;
    await logInAsAlice(page);
    await expect(page.getByText("Signed in as Alice", { exact: true })).toBeVisible();

    const body = await page.evaluate(async (token) => {
      const answer = await fetch("/v1/identity", { headers: { authorization: `Bearer ${token}` } });
      return answer.json();
    }, secret);

    expect(body).toMatchObject({ name: "ci-agent", role: "agent", via: "token" });
  });
});
