import "./command-palette.css";

import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useId, useState } from "react";

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
}

export interface PaletteGroup {
  readonly name: string;
  // why: a group still loading, or one that failed to load, shows this line in place of results.
  readonly note?: string;
  readonly items: readonly PaletteItem[];
}

// why: the highlight is kept by the result's id, not its place in the list: a group that fills in
// above it moves it down the page but never onto another result. Typing is the one thing that
// starts over, on the first result of the new list. The listbox is written here rather than taken
// from Base UI's Autocomplete, whose highlight is an index it resets whenever the items change.
function useHighlight(items: readonly PaletteItem[]) {
  const [pinned, setPinned] = useState<string | undefined>(undefined);
  const current = items.some((item) => item.id === pinned) ? pinned : items[0]?.id;
  if (current !== pinned) setPinned(current);
  return { current, move: setPinned };
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
  const listId = useId();
  const items = groups.flatMap((group) => group.items);
  const { current, move } = useHighlight(items);
  const optionId = (id: string) => `${listId}-${id}`;
  useEffect(() => {
    if (current !== undefined) {
      document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    }
  });
  const step = (by: number) => {
    const at = items.findIndex((item) => item.id === current);
    move(items[Math.min(items.length - 1, Math.max(0, at + by))]?.id);
  };
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
          <input
            type="text"
            role="combobox"
            className="palette-input"
            aria-label="Search pages, items and actions"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current === undefined ? undefined : optionId(current)}
            placeholder="Search or jump to…"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => {
              move(undefined);
              onType(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                step(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Enter" && current !== undefined) {
                event.preventDefault();
                onChoose(current);
              }
            }}
          />
          {empty === "" ? null : (
            <p className="palette-empty" role="status">
              {empty}
            </p>
          )}
          <div id={listId} role="listbox" aria-label="Results" className="palette-list">
            {groups.map((group) => (
              <PaletteSection
                key={group.name}
                group={group}
                current={current}
                optionId={optionId}
                onMove={move}
                onChoose={onChoose}
              />
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteSection(props: {
  readonly group: PaletteGroup;
  readonly current: string | undefined;
  readonly optionId: (id: string) => string;
  readonly onMove: (id: string) => void;
  readonly onChoose: (id: string) => void;
}) {
  const { current, group, onChoose, onMove, optionId } = props;
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="palette-group">
      <p id={labelId} className="palette-group-label">
        {group.name}
      </p>
      {group.note === undefined ? null : <p className="palette-note">{group.note}</p>}
      {group.items.map((item) => (
        <div
          key={item.id}
          id={optionId(item.id)}
          role="option"
          aria-selected={item.id === current}
          data-highlighted={item.id === current ? "" : undefined}
          className="palette-item"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => onMove(item.id)}
          onClick={() => onChoose(item.id)}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
