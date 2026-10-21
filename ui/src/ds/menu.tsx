import "./menu.css";

import { Menu } from "@base-ui/react/menu";

import { IconButton } from "./button";
import { Icon } from "./icon";

export interface MenuEntry {
  readonly key: string;
  readonly label: string;
  readonly danger: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}

// why: a click inside the popup reaches the table row through React's tree (the popup is a portal),
// and a row that opens its item must not open it for a menu entry.
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

export function RowMenu(props: { readonly label: string; readonly entries: readonly MenuEntry[] }) {
  const { entries, label } = props;
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
        <Menu.Positioner align="end" sideOffset={4}>
          <Menu.Popup className="menu" onClick={(event) => event.stopPropagation()}>
            <MenuItems entries={entries} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
