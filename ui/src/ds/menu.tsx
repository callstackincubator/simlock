import "./menu.css";

import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import type { MouseEventHandler, ReactNode } from "react";

import { Button, IconButton } from "./button";
import { Icon } from "./icon";

export interface MenuEntry {
  readonly key: string;
  readonly label: string;
  readonly danger: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

function MenuItems({ entries }: { readonly entries: readonly MenuEntry[] }) {
  const first = entries.findIndex((entry) => entry.danger);
  return entries.map((entry, index) => (
    <div key={entry.key} role="presentation">
      {index === first && first > 0 ? <Menu.Separator className="menu-separator" /> : null}
      <Menu.Item
        className={entry.danger ? "menu-item menu-item-danger" : "menu-item"}
        disabled={entry.disabled}
        onClick={entry.onSelect}
      >
        {entry.label}
      </Menu.Item>
    </div>
  ));
}

// why: a right-click on a table row opens the same entries as its ⋯.
export function MenuRow(props: {
  readonly entries: readonly MenuEntry[];
  readonly className?: string | undefined;
  readonly onClick?: MouseEventHandler<HTMLTableRowElement> | undefined;
  readonly children: ReactNode;
}) {
  const { children, className, entries, onClick } = props;
  if (entries.length === 0) {
    return (
      <tr className={className} onClick={onClick}>
        {children}
      </tr>
    );
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={<tr className={className} onClick={onClick} />}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="menu-positioner">
          <ContextMenu.Popup className="menu">
            <MenuItems entries={entries} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// why: a click in the ⋯ popup reaches the table row through React's tree (the popup is a portal),
// and a row that opens its item must not open it for a menu entry.
export function RowMenu(props: { readonly label: string; readonly entries: readonly MenuEntry[] }) {
  const { entries, label } = props;
  if (entries.length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <IconButton aria-label={label}>
            <Icon name="more" />
          </IconButton>
        }
      />
      <Menu.Portal>
        <Menu.Positioner className="menu-positioner" align="end" sideOffset={4}>
          <Menu.Popup className="menu" onClick={(event) => event.stopPropagation()}>
            <MenuItems entries={entries} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// why: a drawer or a page shows its item's first safe action as a button and the other actions
// under its own ⋯, the dangerous ones last; the ⋯ does not repeat the button.
export function ActionBar(props: {
  readonly label: string;
  readonly entries: readonly MenuEntry[];
}) {
  const { entries, label } = props;
  const first = entries.find((entry) => !entry.danger);
  if (entries.length === 0) return null;
  return (
    <span className="action-bar">
      {first === undefined ? null : (
        <Button variant="secondary" disabled={first.disabled} onClick={first.onSelect}>
          {first.label}
        </Button>
      )}
      <RowMenu label={label} entries={entries.filter((entry) => entry !== first)} />
    </span>
  );
}
