import "./toolbar.css";

import type { ReactNode } from "react";

// why: every list page puts its filters on the left and its search on the right, so the bar is
// laid out once, at the page title's own padding.
export function Toolbar(props: { readonly start: ReactNode; readonly end?: ReactNode }) {
  return (
    <div className="toolbar">
      <div className="toolbar-start">{props.start}</div>
      {props.end === undefined ? null : <div className="toolbar-end">{props.end}</div>}
    </div>
  );
}
