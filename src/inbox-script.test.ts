import { describe, expect, it } from "vitest";

// @ts-expect-error why: a plain script with no types
import { inboxItems, inboxReport } from "../.agents/scripts/inbox.mjs";

const NOW = "2026-11-18T12:00:00Z";
const TWO_DAYS_AGO = "2026-11-16T12:00:00Z";

function issue(number: number, labels: string[], extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `title ${number}`,
    state: "open",
    labels,
    assignees: [],
    author: "reporter",
    createdAt: TWO_DAYS_AGO,
    body: "",
    parent: null,
    triaged: false,
    pr: null,
    ...extra,
  };
}

const pr = (draft: boolean, head: string, updatedAt = NOW) => ({ pr: { draft, head, updatedAt } });

function sections(issues: unknown[], runnable = {}) {
  const items = inboxItems({ now: NOW, me: "maintainer", issues, runnable });
  return items.map((i: { section: string; number: number }) => `${i.section}#${i.number}`);
}

describe("inbox.mjs", () => {
  it("puts each issue in the section of the person or agent it waits on", () => {
    const pending = "Keeps it. (decided in delivery, pending the maintainer)";

    expect(
      sections(
        [
          issue(1, ["bug:new"], { triaged: true }),
          issue(2, ["bug:new"]),
          issue(3, ["bug:new"], { assignees: ["agent"] }),
          issue(4, ["task:blocked"]),
          issue(5, ["bug:blocked", "upstream"]),
          issue(6, ["os:windows"]),
          issue(7, ["request:new"]),
          issue(8, ["feature:spec"]),
          issue(9, ["task:draft"], { parent: 8 }),
          issue(10, ["task:draft"]),
          issue(11, ["bug:ready"]),
          issue(12, ["feature:planned"]),
          issue(13, ["feature:planned"]),
          issue(14, ["task:ready"], { state: "closed", body: pending }),
        ],
        { 12: [20, 21] },
      ),
    ).toEqual([
      "decide#1",
      "untriaged#2",
      "decide#4",
      "sort#6",
      "session#7",
      "session#8",
      "session#10",
      "run#11",
      "run#12",
      "decisions#14",
    ]);
  });

  it("lists a PR only when a person has to act on it", () => {
    const mine = { author: "maintainer" };
    const idle = "2026-11-10T12:00:00Z";

    const items = inboxItems({
      now: NOW,
      me: "maintainer",
      issues: [
        issue(1, [], pr(false, "fix/x")),
        issue(2, [], pr(true, "fix/y")),
        issue(3, [], { ...mine, ...pr(false, "bug/3") }),
        issue(4, [], { ...mine, ...pr(false, "feature/9-adr") }),
        issue(5, [], { ...mine, ...pr(true, "chore/audit-tests", idle) }),
        issue(6, [], { ...mine, ...pr(true, "chore/audit-tests") }),
        issue(7, ["needs-hardware"], { ...mine, ...pr(true, "task/7") }),
      ],
    });

    expect(
      items.map((i: { number: number; action: string }) => `${i.number}: ${i.action}`),
    ).toEqual([
      "1: review it",
      "3: ready, not merged: merge it, or read why the gate held it",
      "5: routine PR stuck in draft: finish or close it",
      "7: run the slow lane: verify-hardware",
    ]);
  });

  it("marks what is new since the saved snapshot and names what left", () => {
    const items = inboxItems({
      now: NOW,
      me: "maintainer",
      issues: [issue(7, ["request:new"]), issue(8, ["feature:spec"])],
    });

    const first = inboxReport(items, null);
    const later = inboxReport(items, ["session#7", "sort#8"]);

    expect(first.text.split("\n")[0]).toBe("Inbox: 2 items, 0 new, 0 gone. Changed: no");
    expect(first.keys).toEqual(["session#7", "session#8"]);
    expect(later.text).toBe(
      [
        "Inbox: 2 items, 1 new, 1 gone. Changed: yes",
        "",
        "## session",
        "  #7 2d request:new | spec-session, or close it | title 7",
        "+ #8 2d feature:spec | spec-session to finish the spec | title 8",
        "",
        "Gone: sort#8",
      ].join("\n"),
    );
  });
});
