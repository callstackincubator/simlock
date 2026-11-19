import "./hint.css";

import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

// why: a line of detail that would crowd a table cell shows on hover and on keyboard focus of its
// subject. Base UI wires `aria-describedby` and closes on Escape; the subject takes the tab stop.
export function Hint(props: { readonly text: string; readonly children: ReactNode }) {
  const { children, text } = props;
  if (text === "") return <>{children}</>;
  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root>
        <Tooltip.Trigger render={<span className="hint-subject" tabIndex={0} />}>
          {children}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner className="hint-positioner" side="top" sideOffset={6}>
            <Tooltip.Popup className="hint">{text}</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
