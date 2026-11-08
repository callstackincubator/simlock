import { mkdir } from "node:fs/promises";

import type { Locator, Page } from "@playwright/test";

import { expect, signIn, test } from "./fixtures.js";
import { startHostWithLease, visit } from "./pages.js";
import { writeCaptureProgram } from "./screen-capture.js";
import { stubJson, staticWorker, waitingItem } from "./stubs.js";

// why: a computed colour, size or gap is what the browser's style engine makes of the stylesheet,
// which no DOM can show. The workers the page is given are written out by hand, so the same colour
// is expected on any machine whatever its memory, disk or CPU happen to be.

async function openFleet(page: Page, url: string, token: string): Promise<void> {
  await page.goto(url);
  await signIn(page, token);
  await page.getByRole("link", { name: "Fleet", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fleet" })).toBeVisible();
}

// why: a worker is a row of the Fleet table, found by the link that carries its name.
function row(page: Page, name: string): Locator {
  return page
    .locator(".fleet-table tbody tr:not(.table-group)")
    .filter({ has: page.getByRole("link", { exact: true, name }) });
}

function figures(page: Page): Locator {
  return page.getByRole("group", { name: "Load and leases" });
}

function figure(page: Page, label: string): Locator {
  return figures(page)
    .locator(".worker-gauge")
    .filter({ has: page.locator(".fleet-label", { hasText: label }) });
}

const TONES = ["ok", "warn", "error", "idle"] as const;

const TONE_OF: Readonly<Partial<Record<string, (typeof TONES)[number]>>> = {
  compatible: "ok",
  connected: "ok",
  drained: "warn",
  error: "error",
  idle: "idle",
  incompatible: "error",
  info: "idle",
  leased: "idle",
  live: "ok",
  off: "idle",
  ok: "ok",
  ready: "ok",
  running: "ok",
  warn: "warn",
};

async function readStatusIndicators(page: Page) {
  const pills = await page.locator(".pill").evaluateAll((elements) =>
    elements.map((element) => ({
      ariaHidden: element.querySelector(".pill-dot")?.getAttribute("aria-hidden") ?? "true",
      ariaLabel: null,
      colour: getComputedStyle(element).color,
      kind: "pill" as const,
      role: null,
      title: null,
      word: element.textContent?.trim() ?? "",
    })),
  );
  const rest = await readStatusDots(page);
  return { ...rest, shown: [...pills, ...rest.shown] };
}

async function readStatusDots(page: Page) {
  return page.locator(".status-dot").evaluateAll((elements) => {
    const root = getComputedStyle(document.documentElement);
    const named = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = root.getPropertyValue(token).trim();
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    return {
      accent: named("--accent"),
      neutral: named("--slot-leased"),
      shown: elements.map((element) => ({
        ariaHidden: element.getAttribute("aria-hidden"),
        ariaLabel: element.getAttribute("aria-label"),
        colour: getComputedStyle(element).backgroundColor,
        kind:
          element.closest(".status") && !element.closest(".sidebar-account")
            ? ("pill" as const)
            : ("standalone" as const),
        role: element.getAttribute("role"),
        title: element.getAttribute("title"),
        word:
          element.getAttribute("aria-label") ?? element.parentElement?.textContent?.trim() ?? "",
      })),
      tones: ["--status-ok", "--status-warn", "--status-error", "--status-idle"].map(named),
    };
  });
}

async function expectStatusIndicatorColours(
  page: Page,
  where: string,
  words: readonly (readonly [string, "pill" | "standalone"])[],
  theme: "light" | "dark",
): Promise<void> {
  await expect(page.locator(".pill").first()).toBeVisible();
  const { accent, shown } = await readStatusIndicators(page);
  const colours = {
    light: {
      pill: ["rgb(20, 111, 53)", "rgb(146, 87, 10)", "rgb(185, 28, 28)", "rgb(85, 85, 95)"],
      standalone: ["rgb(21, 128, 61)", "rgb(146, 87, 10)", "rgb(185, 28, 28)", "rgb(87, 83, 78)"],
    },
    dark: {
      pill: ["rgb(134, 239, 172)", "rgb(253, 224, 71)", "rgb(252, 165, 165)", "rgb(185, 185, 194)"],
      standalone: [
        "rgb(74, 222, 128)",
        "rgb(250, 204, 21)",
        "rgb(248, 113, 113)",
        "rgb(168, 162, 158)",
      ],
    },
  } as const;
  for (const [word, kind] of words) {
    expect(shown, where).toEqual(expect.arrayContaining([expect.objectContaining({ word, kind })]));
  }
  for (const indicator of shown) {
    const context = `${indicator.word} ${indicator.kind} in ${where}`;
    expect(indicator.word, where).not.toBe("");
    if (indicator.ariaLabel !== null) {
      expect(indicator.role, context).toBe("img");
      expect(indicator.title, context).toBe(indicator.word);
    } else {
      expect(indicator.ariaHidden, context).toBe("true");
    }
    const palette = colours[theme][indicator.kind];
    expect(indicator.colour, context).not.toBe(accent);
    expect(palette, context).toContain(indicator.colour);
    const tone = TONE_OF[indicator.word.toLowerCase()];
    expect(tone, context).toBeDefined();
    expect(indicator.colour, context).toBe(palette[TONES.indexOf(tone!)]);
  }
}

test.describe("colours and sizes the style engine decides", () => {
  test("a worker page's slot squares are 12px tall with a 3px gap, and the meter above ten slots is 4px tall", async ({
    gateway,
    page,
  }) => {
    await stubJson(page, "/v1/workers", () => ({
      workers: [
        staticWorker({ id: "wrk_ten", label: "ten", limit: 10, load: false }),
        staticWorker({ id: "wrk_twenty", label: "twenty", limit: 20, load: false }),
      ],
    }));
    await openFleet(page, gateway.url, gateway.tokens.operator);
    const side = page.getByRole("complementary", { name: /^Slots, host/ });

    await row(page, "ten").getByRole("link").first().click();
    const ten = side.getByRole("img").first();
    await expect(ten).toHaveCSS("gap", "3px");
    await expect(ten.locator(".slot").first()).toHaveCSS("height", "12px");
    await page.goBack();
    await row(page, "twenty").getByRole("link").first().click();
    await expect(side.getByRole("img").first().locator(".load-bar")).toHaveCSS("height", "4px");
  });

  test("each memory pressure paints its ring in that pressure's colour, and never the accent, in both themes", async ({
    gateway,
    page,
  }) => {
    // why: only macOS reports a memory pressure, so the reading the page is given names the level
    // the case asks for; what is painted is the real component's doing.
    let claim: { usedPercent: number; pressure?: string } = { usedPercent: 50 };
    await stubJson(page, "/v1/workers", () => ({
      workers: [staticWorker({ id: "wrk_mem", label: "mem-a", load: claim })],
    }));
    await openFleet(page, gateway.url, gateway.tokens.operator);
    await row(page, "mem-a").getByRole("link").first().click();
    await expect(figure(page, "Memory")).toContainText("used");

    const memoryFill = () =>
      figure(page, "Memory").evaluate((card) => {
        const ring = card.querySelector(".ring-box") as HTMLElement;
        return {
          tone: /ring-(ok|warn|error|idle|neutral)/.exec(ring.className)?.[1] ?? "",
          colour: getComputedStyle(ring.querySelector(".ring-value") as SVGCircleElement).stroke,
        };
      });
    const paintedFills = () =>
      figures(page)
        .locator(".ring-box")
        .evaluateAll((rings) =>
          rings.map((ring) => ({
            tone: /ring-(ok|warn|error|idle|neutral)/.exec(ring.className)?.[1] ?? "",
            colour: getComputedStyle(ring.querySelector(".ring-value") as SVGCircleElement).stroke,
          })),
        );

    // why: these six are the whole colour rule for a memory bar: the worker's three words, that
    // the word outranks the console's threshold, and the threshold on its own at either end. Each is
    // seen in each theme by the real component, so a tone rule deleted, swapped, or given the accent
    // fails a named assertion here. A figure under its threshold is the neutral tone.
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      const { accent, neutral, tones } = await readStatusIndicators(page);

      for (const [level, usedPercent, tone] of [
        ["normal", 50, "ok"],
        ["warn", 50, "warn"],
        ["critical", 50, "error"],
        ["normal", 97, "ok"],
        [undefined, 97, "error"],
        [undefined, 50, "neutral"],
      ] as const) {
        claim = { usedPercent, ...(level === undefined ? {} : { pressure: level }) };
        await page.reload();
        const want = tone === "neutral" ? neutral : tones[TONES.indexOf(tone)];
        const at = `${usedPercent}%${level === undefined ? " with no word" : ` and ${level}`}`;
        await expect
          .poll(() => memoryFill(), {
            timeout: 5_000,
            message: `${at} to paint the ${tone} bar in ${colorScheme}`,
          })
          .toEqual({ tone, colour: want });
        expect(want, `the ${tone} bar in ${colorScheme}`).not.toBe(accent);

        // why: the poll above watches the memory bar; this watches the rest of the figures, for
        // the one thing a poll of a single bar cannot see.
        const fills = await paintedFills();
        expect(fills.length).toBeGreaterThan(1);
        for (const fill of fills) {
          expect(fill.tone, "a bar carries a tone class").not.toBe("");
          expect(fill.colour, `the ${fill.tone} bar`).not.toBe(accent);
        }
      }
    }
  });

  test("every status indicator shows its word with its context's status colour, and none uses the accent colour", async ({
    gateway,
    page,
  }) => {
    await stubJson(page, "/v1/workers", () => ({
      workers: [
        staticWorker({ id: "wrk_a", label: "worker-a", leased: true, load: false }),
        staticWorker({ id: "wrk_b", label: "worker-b", drained: true, load: false }),
        staticWorker({
          connection: "incompatible",
          id: "wrk_old",
          label: "old-worker",
          load: false,
        }),
      ],
    }));
    await openFleet(page, gateway.url, gateway.tokens.operator);
    await expect(row(page, "old-worker")).toContainText("incompatible");
    await expect(row(page, "worker-b")).toContainText("drained");

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page
        .getByRole("navigation", { name: "Console" })
        .getByRole("link", { name: "Fleet" })
        .click();
      await expect(page.getByRole("region", { name: "Worker events" })).toBeVisible();
      await expectStatusIndicatorColours(
        page,
        `list ${colorScheme}`,
        [
          ["drained", "pill"],
          ["incompatible", "pill"],
          ["live", "pill"],
        ],
        colorScheme,
      );
      await row(page, "worker-a").getByRole("link").first().click();
      await expect(page.getByRole("region", { name: "Events on this worker" })).toBeVisible();
      await expectStatusIndicatorColours(
        page,
        `worker ${colorScheme}`,
        [
          ["connected", "pill"],
          ["leased", "pill"],
          ["live", "pill"],
        ],
        colorScheme,
      );
    }
  });

  test("existing pages keep usable shared controls after retired-token substitution in both themes, and the body follows the system setting", async ({
    page,
  }, testInfo) => {
    const dir = testInfo.outputPath("capture");
    await mkdir(dir, { recursive: true });
    const { host, pages } = await startHostWithLease(await writeCaptureProgram(dir));
    try {
      for (const [theme, background, surface, text] of [
        ["light", "rgb(248, 248, 247)", "rgb(242, 242, 240)", "rgb(17, 17, 16)"],
        ["dark", "rgb(12, 12, 14)", "rgb(27, 27, 31)", "rgb(236, 236, 234)"],
      ] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(host.url);
        await expect(page.getByLabel("Operator token")).toHaveCSS("background-color", background);
        await expect(page.locator(".byline")).toHaveCSS("background-color", surface);
        const signInButton = page.getByRole("button", { name: "Sign in" });
        await expect(signInButton).toHaveCSS("min-height", "30px");
        await expect(signInButton).toHaveCSS("border-radius", "8px");
        await expect(signInButton).toHaveCSS("text-transform", "none");
        await expect(signInButton).toHaveCSS("font-family", /Geist Variable/);
        await signIn(page, host.tokens.operator);
        await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
        await expect(page.locator("body")).toHaveCSS("background-color", background);
        await expect(page.locator("body")).toHaveCSS("color", text);
        await expect(page.locator(".chart .recharts-cartesian-axis-tick-value").first()).toHaveCSS(
          "font-size",
          "10px",
        );
        await expect(page.locator(".panel-header").first()).toHaveCSS("gap", "8px");
        await visit(page, host, "/fleet");
        await expect(page.locator(".table-card").first()).toHaveCSS("border-radius", "10px");
        await expect(page.locator(".chips").first()).toHaveCSS("border-radius", "8px");
        await expect(page.getByRole("searchbox").first()).toHaveCSS("min-height", "30px");
        await expect(page.locator(".search-field-wrap .icon")).toBeVisible();
        const dark = theme === "dark";
        const search = page.getByRole("searchbox").first();
        await expect(search).toHaveCSS(
          "border-top-color",
          dark ? "rgb(35, 35, 39)" : "rgb(222, 222, 219)",
        );
        await expect(search).toHaveCSS("background-color", background);
        await expect(search).toHaveCSS("border-top-left-radius", "8px");
        const status = page.locator("#main .pill").first();
        await expect(status).toHaveCSS("height", "20px");
        if (theme === "dark") {
          const tone = await status.getAttribute("class");
          const colors = tone?.includes("pill-ok")
            ? ["rgb(134, 239, 172)", "rgb(27, 46, 36)"]
            : tone?.includes("pill-warn")
              ? ["rgb(253, 224, 71)", "rgb(50, 44, 22)"]
              : tone?.includes("pill-error")
                ? ["rgb(252, 165, 165)", "rgb(54, 34, 36)"]
                : ["rgb(185, 185, 194)", "rgb(36, 36, 42)"];
          await expect(status).toHaveCSS("color", colors[0]!);
          await expect(status).toHaveCSS("background-color", colors[1]!);
        }
        await stubJson(page, "/v1/inbox", () => ({ items: [waitingItem("req_tokens", 125_000)] }));
        await visit(page, host, "/inbox");
        const inboxRow = page.locator(".inbox-row").first();
        await inboxRow.hover();
        await expect(inboxRow).toHaveCSS("background-color", surface);
        await page.unrouteAll({ behavior: "wait" });
        await visit(page, host, pages.lease);
        const facts = page.locator(".facts").first();
        await expect(facts).toHaveCSS("row-gap", "8px");
        await expect(facts.locator("dt").first()).toHaveCSS("text-transform", "none");
        expect(
          await facts
            .locator(":scope > div")
            .first()
            .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ")[0]),
        ).toBe("92px");
        await page.keyboard.press("Escape");
        await visit(page, host, pages.device);
        await page.getByRole("link", { name: "Watch" }).click();
        await expect(page.locator(".phone")).toHaveCSS("background-color", "rgb(0, 0, 0)");
        await page.getByRole("button", { name: "Stop watching" }).click();
        await page.getByRole("button", { name: "Sign out" }).click();
        await expect(page.getByLabel("Operator token")).toBeVisible();
      }
    } finally {
      await host.dispose();
    }
  });
});
