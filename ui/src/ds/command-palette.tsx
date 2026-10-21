import "./command-palette.css";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";

// why: the dialog is mounted only while open, so each opening starts from an empty box.
export function CommandPalette(props: { readonly onClose: () => void }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-dim" />
        <Dialog.Popup className="palette">
          <Dialog.Title className="visually-hidden">Search</Dialog.Title>
          <Autocomplete.Root items={[]} inline open>
            <Autocomplete.Input
              className="palette-input"
              aria-label="Search pages, items and actions"
              placeholder="Search or jump to…"
            />
            <Autocomplete.List className="palette-list" />
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
