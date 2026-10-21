import "./command-palette.css";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
}

export interface PaletteGroup {
  readonly name: string;
  readonly items: readonly PaletteItem[];
}

// why: the dialog is mounted only while open, so each opening starts from an empty box. The caller
// filters and orders the groups; the box only reports what was typed.
export function CommandPalette(props: {
  readonly groups: readonly PaletteGroup[];
  readonly typed: string;
  readonly empty: string;
  readonly onType: (typed: string) => void;
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
}) {
  const { empty, groups, onChoose, onClose, onType, typed } = props;
  const items = groups.map((group) => ({ items: group.items, value: group.name }));
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-dim" />
        <Dialog.Popup className="palette">
          <Dialog.Title className="visually-hidden">Search</Dialog.Title>
          <Autocomplete.Root
            items={items}
            filter={null}
            value={typed}
            onValueChange={onType}
            itemToStringValue={(item: PaletteItem) => item.label}
            autoHighlight="always"
            inline
            open
          >
            <Autocomplete.Input
              className="palette-input"
              aria-label="Search pages, items and actions"
              placeholder="Search or jump to…"
            />
            <Autocomplete.Empty className="palette-empty">{empty}</Autocomplete.Empty>
            <Autocomplete.List className="palette-list">
              {(group: { value: string; items: readonly PaletteItem[] }) => (
                <Autocomplete.Group key={group.value} items={group.items} className="palette-group">
                  <Autocomplete.GroupLabel className="palette-group-label">
                    {group.value}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(item: PaletteItem) => (
                      <Autocomplete.Item
                        key={item.id}
                        value={item}
                        className="palette-item"
                        onClick={() => onChoose(item.id)}
                      >
                        {item.label}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
