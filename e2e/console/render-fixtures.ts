import type { Page } from "@playwright/test";

export interface RenderCase {
  readonly name: string;
  readonly path: string;
}

export async function renderCases(): Promise<readonly RenderCase[]> {
  return [];
}

export async function renderFixture(
  _page: Page,
  _scenario: "populated" | "empty" | "long" | "refused" = "populated",
): Promise<void> {}
