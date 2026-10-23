import "./popover.css";

import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";

import { IconButton } from "./button";
import { Icon } from "./icon";

// why: an ⓘ button that opens a small panel of facts beside it: Escape, a click outside and a second
// click on the button all close it, and none of them reaches the drawer the button sits in.
export function InfoPopover(props: { readonly label: string; readonly children: ReactNode }) {
  const { children, label } = props;
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <IconButton aria-label={label}>
            <Icon name="info" />
          </IconButton>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="popover-positioner" align="end" sideOffset={4}>
          <Popover.Popup className="popover" aria-label={label}>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
