import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type Column, DataTable, type MenuEntry, type Paging } from "./index";

interface Row {
  readonly group: string;
  readonly id: string;
  readonly name: string;
}

const COLUMNS: readonly Column<Row>[] = [
  { cell: (row) => row.name, header: "Name", mono: true },
  { cell: (row) => row.group, header: "Group", mono: true },
];

const LABELS: Record<string, string> = {
  android: "Android · 2 baselines",
  ios: "iOS · 3 baselines",
};

// why: three iOS rows then two Android ones, so a page of two cuts through the iOS group.
const ROWS: readonly Row[] = [
  { group: "ios", id: "b1", name: "ios-18" },
  { group: "ios", id: "b2", name: "ios-17" },
  { group: "ios", id: "b3", name: "ios-16" },
  { group: "android", id: "b4", name: "android-35" },
  { group: "android", id: "b5", name: "android-34" },
];

const ENTRY: MenuEntry = {
  danger: false,
  disabled: false,
  key: "open",
  label: "Open",
  onSelect: () => {},
};

function pager(page: number, size: number, range: string): Paging {
  return {
    go: () => undefined,
    last: Math.ceil(ROWS.length / size),
    page,
    range,
    resize: () => undefined,
    size,
    sizes: [2, 25],
    total: ROWS.length,
  };
}

function tableRows(markup: string): string {
  return /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? "";
}

function dataRows(markup: string): readonly { readonly attrs: string; readonly name: string }[] {
  return [...tableRows(markup).matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)]
    .map(([, attrs = "", body = ""]) => ({
      attrs,
      name: /<td[^>]*>([^<]*)<\/td>/.exec(body)?.[1] ?? "",
    }))
    .filter((row) => !row.attrs.includes("table-group"));
}

function groupHeadings(markup: string): readonly string[] {
  return [...tableRows(markup).matchAll(/<tr\b[^>]*table-group[^>]*>([\s\S]*?)<\/tr>/g)].map(
    ([, body = ""]) => (/<td[^>]*>([^<]*)<\/td>/.exec(body)?.[1] ?? "").trim(),
  );
}

function draw(props: {
  readonly footer?: "count" | "pager";
  readonly group?: boolean;
  readonly menu?: boolean;
  readonly paging?: Paging;
  readonly rowTo?: boolean;
  readonly selectedId?: string;
}): string {
  return renderToStaticMarkup(
    <DataTable
      columns={COLUMNS}
      empty="No baselines."
      footer={props.footer}
      groupBy={
        props.group === false
          ? undefined
          : (row) => ({ id: row.group, label: LABELS[row.group] ?? row.group })
      }
      label="Baselines"
      menu={
        props.menu === false
          ? undefined
          : { entries: () => [ENTRY], label: (row) => `Actions for ${row.name}` }
      }
      paging={props.paging}
      rowId={(row) => row.id}
      rowTo={props.rowTo === false ? undefined : (row) => `/baselines/${row.id}`}
      rows={ROWS}
      selectedId={props.selectedId}
    />,
  );
}

const PAGE_1 = pager(1, 2, "1–2 of 5");
const PAGE_2 = pager(2, 2, "3–4 of 5");

describe("a table drawn through its public props", () => {
  it("groups the paged rows with a heading that is never a data row, marks only the selected row, and prints a count instead of a pager", () => {
    const first = draw({ paging: PAGE_1 });
    const second = draw({ paging: PAGE_2 });

    expect(dataRows(first).map((row) => row.name)).toEqual(["ios-18", "ios-17"]);
    expect(groupHeadings(first)).toEqual(["iOS · 3 baselines"]);
    expect(first).toContain('<td colSpan="3">iOS · 3 baselines</td>');
    expect(dataRows(second).map((row) => row.name)).toEqual(["ios-16", "android-35"]);
    expect(groupHeadings(second)).toEqual(["iOS · 3 baselines", "Android · 2 baselines"]);

    const chosen = draw({ paging: PAGE_2, selectedId: "b3" });
    const marked = dataRows(chosen).filter((row) => row.attrs.includes('aria-selected="true"'));
    expect(marked.map((row) => row.name)).toEqual(["ios-16"]);
    expect(marked[0]?.attrs).toContain("table-row-selected");
    expect(dataRows(chosen).filter((row) => row.attrs.includes("table-row-selected"))).toHaveLength(
      1,
    );
    expect(chosen.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(chosen.match(/table-row-selected/g)).toHaveLength(1);

    const counted = draw({ footer: "count", paging: PAGE_2 });
    expect(counted).toContain("3–4 of 5");
    expect(counted).not.toContain("Per page");
    expect(counted).not.toContain("Previous");
    expect(dataRows(counted).map((row) => row.name)).toEqual(["ios-16", "android-35"]);
    expect(groupHeadings(counted)).toEqual(["iOS · 3 baselines", "Android · 2 baselines"]);

    const every = draw({ footer: "count" });
    expect(dataRows(every)).toHaveLength(5);
    expect(groupHeadings(every)).toEqual(["iOS · 3 baselines", "Android · 2 baselines"]);
    expect(every).toContain("1–5 of 5");

    const plain = draw({ paging: PAGE_1 });
    expect(plain).toContain('aria-label="Baselines pages"');
    expect(plain).toContain("Previous");
    expect(plain).toContain("Per page");
    expect(plain).not.toContain("aria-selected");

    const bare = draw({ menu: false, paging: PAGE_1, rowTo: false });
    expect(bare).not.toContain("table-row-link");
    expect(bare).not.toContain("table-menu");
    expect(groupHeadings(bare)).toEqual(["iOS · 3 baselines"]);
    expect(bare).toContain('<td colSpan="2">iOS · 3 baselines</td>');
    expect(dataRows(bare)).toHaveLength(2);

    const ungrouped = draw({ group: false, menu: false, paging: PAGE_1, rowTo: false });
    expect(groupHeadings(ungrouped)).toEqual([]);
    expect(dataRows(ungrouped).map((row) => row.name)).toEqual(["ios-18", "ios-17"]);
    expect(ungrouped).toContain('aria-label="Baselines pages"');
    expect(draw({ menu: false, paging: PAGE_1 })).toContain("table-row-link");
    expect(draw({ paging: PAGE_1, rowTo: false })).toContain("Actions for ios-18");
  });
});
