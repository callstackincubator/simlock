import "./feed.css";

import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";

// why: the box's height and a row's before either is measured: what a first draw lays out. A row's
// height is fixed (the caller's rows do not wrap), so no row is measured as it is drawn.
const BOX_HEIGHT_PX = 640;

// why: rows drawn past each edge of the box, so a short scroll shows rows already there.
const OVERSCAN = 5;

// why: how close to the last row the last drawn row must be before the list asks for more.
const NEAR_END_ROWS = 20;

// why: only the rows in view, and a few past each edge, are in the page; the space of the rest is
// padding, so the scroll bar is as long as every row. New rows come in at the top: while the box
// is at the top they push the rows down, so the newest is always in view; once the reader scrolls
// down the row they are reading stays where it is (`anchorTo: "end"`), and a button counts the
// rows that came in since and scrolls back to the top.
export function Feed(props: {
  readonly label: string;
  readonly listLabel: string;
  readonly count: number;
  readonly rowHeight: number;
  readonly keyAt: (index: number) => string;
  readonly newText: (count: number) => string;
  readonly startAt?: number;
  readonly onNearEnd?: (() => void) | undefined;
  // why: below the scrolling box, outside the list, so it never counts as a row.
  readonly footer?: ReactNode;
  readonly renderRow: (index: number) => ReactNode;
}) {
  const {
    count,
    footer,
    keyAt,
    label,
    listLabel,
    newText,
    onNearEnd,
    renderRow,
    rowHeight,
    startAt = 0,
  } = props;
  const box = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const unseen = useUnseen(count, keyAt, atTop);
  const virtualizer = useVirtualizer({
    anchorTo: atTop ? "start" : "end",
    count,
    estimateSize: () => rowHeight,
    getItemKey: keyAt,
    getScrollElement: () => box.current,
    initialRect: { height: BOX_HEIGHT_PX, width: 0 },
    overscan: OVERSCAN,
  });
  useOpenAt(startAt, virtualizer);
  const toTop = () => {
    virtualizer.scrollToOffset(0);
    box.current?.focus();
  };
  const items = virtualizer.getVirtualItems();
  useNearEnd(items.at(-1)?.index, count, onNearEnd);
  const before = items[0]?.start ?? 0;
  const after = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));
  return (
    <div className="feed" style={{ "--feed-row": `${rowHeight}px` } as CSSProperties}>
      {unseen === 0 ? null : (
        <button className="button button-secondary feed-new" type="button" onClick={toTop}>
          {newText(unseen)}
        </button>
      )}
      <div
        ref={box}
        className="feed-box"
        role="region"
        aria-label={label}
        tabIndex={0}
        onScroll={(event) => setAtTop(event.currentTarget.scrollTop < 1)}
      >
        <ul
          className="list feed-list"
          aria-label={listLabel}
          style={{ paddingBottom: after, paddingTop: before }}
        >
          {items.map((item) => (
            <Fragment key={item.key.toString()}>{renderRow(item.index)}</Fragment>
          ))}
        </ul>
      </div>
      {footer}
    </div>
  );
}

// why: the callback is read through a ref, so a new function on each render does not ask again;
// only a change in the last drawn row or in the count does.
function useNearEnd(last: number | undefined, count: number, onNearEnd: (() => void) | undefined) {
  const callback = useRef(onNearEnd);
  callback.current = onNearEnd;
  // why: the box's height settles after the first draw (it fills the page), which moves the last
  // drawn row; the list asks once per number of rows, not once per change of what is drawn.
  const askedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (last === undefined || last < count - NEAR_END_ROWS || askedAt.current === count) return;
    askedAt.current = count;
    callback.current?.();
  }, [last, count]);
}

function useUnseen(count: number, keyAt: (index: number) => string, atTop: boolean): number {
  const newest = count === 0 ? undefined : keyAt(0);
  // why: the newest row the reader saw at the top of the box: every row above it is new to them.
  const [seen, setSeen] = useState(newest);
  useEffect(() => {
    if (atTop) setSeen(newest);
  }, [atTop, newest]);
  if (atTop) return 0;
  let unseen = 0;
  while (unseen < count && keyAt(unseen) !== seen) unseen += 1;
  // why: a row the reader saw that is no longer held (past the cap) leaves nothing to count from.
  return unseen === count ? 0 : unseen;
}

// why: once, when the box opens: a row chosen by a link is brought into view, and later choices
// are the reader's own scrolling to keep.
function useOpenAt(
  startAt: number,
  virtualizer: { readonly scrollToIndex: (index: number, options: { align: "center" }) => void },
): void {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (startAt > 0) virtualizer.scrollToIndex(startAt, { align: "center" });
  }, [startAt, virtualizer]);
}
