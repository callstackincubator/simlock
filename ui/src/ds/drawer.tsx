import "./drawer.css";

import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useState } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

// why: a drawer is a modal dialog drawn at the right edge: the rest of the console, sidebar
// included, goes dim and inert, and Escape, the close button and the dim layer all ask to close.
export function Drawer(props: {
  readonly title: ReactNode;
  readonly onClose: () => void;
  // why: the element focus goes to on closing; with none found, focus goes where it was before.
  readonly finalFocus?: () => HTMLElement | null;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const { actions, children, finalFocus, onClose, title } = props;
  // why: closing changes the address, which unmounts the drawer at once; it closes itself first,
  // and the address changes once Base UI has played the slide-out.
  const [open, setOpen] = useState(true);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="drawer-dim" />
        <Dialog.Popup className="drawer" finalFocus={finalFocus}>
          <header className="drawer-head">
            <Dialog.Title className="drawer-title mono">{title}</Dialog.Title>
            <span className="drawer-head-end">
              {actions}
              <Dialog.Close
                render={
                  <IconButton aria-label="Close">
                    <Icon name="close" />
                  </IconButton>
                }
              />
            </span>
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface DrawerTab {
  readonly value: string;
  readonly label: string;
  readonly keepMounted?: boolean;
  readonly content: ReactNode;
}

// why: a tab that holds something running, such as a live screen, stays mounted while another tab
// shows, so switching tabs never stops it.
export function DrawerTabs(props: {
  readonly tabs: readonly DrawerTab[];
  readonly defaultValue: string;
  readonly label: string;
}) {
  const { defaultValue, label, tabs } = props;
  return (
    <Tabs.Root className="drawer-tabs" defaultValue={defaultValue}>
      <Tabs.List className="drawer-tab-list" aria-label={label}>
        {tabs.map((tab) => (
          <Tabs.Tab key={tab.value} value={tab.value} className="drawer-tab">
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {tabs.map((tab) => (
        <Tabs.Panel
          key={tab.value}
          value={tab.value}
          keepMounted={tab.keepMounted === true}
          className="drawer-panel"
        >
          {tab.content}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
