import type { Page } from "@playwright/test";

export type VisibleState = unknown;

export async function visibleState(_page: Page): Promise<VisibleState> {
  return undefined;
}

export async function compareCaptures(
  _page: Page,
  first: Buffer,
  second: Buffer,
  firstState: VisibleState,
  secondState: VisibleState,
): Promise<{
  matches: boolean;
  changedPixels: number;
  maxRgbDelta: number;
  alphaChanged: boolean;
  dimensionsMatch: boolean;
  stateMatches: boolean;
}> {
  const stateMatches = JSON.stringify(firstState) === JSON.stringify(secondState);
  return {
    matches: first.equals(second) && stateMatches,
    changedPixels: 0,
    maxRgbDelta: 0,
    alphaChanged: false,
    dimensionsMatch: true,
    stateMatches,
  };
}
