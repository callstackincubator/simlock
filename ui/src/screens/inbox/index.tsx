import "./inbox.css";

import {
  Button,
  ButtonLink,
  ChoiceChips,
  ActionBar,
  Drawer,
  Empty,
  Facts,
  focusAfterClosing,
  Link,
  Loaded,
  Page,
  Panel,
  RowMenu,
  Status,
  StatusDot,
  Toolbar,
} from "../../ds";
import {
  INBOX_FILTERS,
  type InboxEvent,
  type InboxFilter,
  type InboxPage,
  type InboxRow,
  type InboxRowActions,
  useInbox,
  useInboxActions,
  useInboxDrawer,
} from "../../state/inbox";

const GROUP_ORDER = ["Broken", "Needs a look", "Heads-up"] as const;

export function InboxScreen() {
  const { choose, couldNotCheck, filter, rows, urlId, view } = useInbox();
  const { close, fromList } = useInboxDrawer(urlId);
  const actionsOf = useInboxActions();
  const drawerActions = (row: InboxRow | undefined) =>
    row === undefined ? null : (
      <ActionBar label={`Actions for ${row.subject}`} entries={actionsOf(row).menu} />
    );
  return (
    <Page
      title="Inbox"
      actions={
        view.kind === "ready" ? <span className="muted">{view.data.problems} open</span> : null
      }
    >
      <Toolbar
        start={
          <ChoiceChips
            legend="Filter Inbox"
            choices={INBOX_FILTERS}
            value={filter}
            onChange={choose}
          />
        }
      />
      <Loaded view={view}>
        {(page) => (
          <>
            <InboxBody
              rows={rows(page)}
              filter={filter}
              couldNotCheck={couldNotCheck}
              actionsOf={actionsOf}
            />
            {urlId === undefined ? null : (
              <Drawer
                key={urlId}
                title={typeof page.shown === "object" ? page.shown.title : "Inbox item"}
                actions={drawerActions(rows(page).find((row) => row.key === urlId))}
                onClose={close}
                finalFocus={() =>
                  focusAfterClosing({
                    fromList,
                    links: "main .inbox-list a",
                    path: `/inbox/${encodeURIComponent(urlId)}`,
                  })
                }
              >
                <InboxDrawerBody shown={page.shown} />
              </Drawer>
            )}
          </>
        )}
      </Loaded>
    </Page>
  );
}

export function InboxBody(props: {
  readonly rows: readonly InboxRow[];
  readonly filter: InboxFilter;
  readonly couldNotCheck?: readonly string[];
  readonly actionsOf?: (row: InboxRow) => InboxRowActions;
}) {
  const { actionsOf, couldNotCheck = [], filter, rows } = props;
  const unchecked =
    couldNotCheck.length === 0 ? null : (
      <p className="muted">{`Could not check: ${couldNotCheck.join(", ")}`}</p>
    );
  if (rows.length === 0) {
    // why: an Inbox that could not read everything never claims nothing needs you.
    if (unchecked !== null) return unchecked;
    return (
      <div className="table-card">
        <p className="muted table-empty">
          {filter === "all" ? "Nothing needs you." : "Nothing in this group."}
        </p>
      </div>
    );
  }
  return (
    <>
      {unchecked}
      {GROUP_ORDER.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        return inGroup.length === 0 ? null : (
          <Panel key={group} title={group} flush>
            <ul className="inbox-list">
              {inGroup.map((row) => (
                <li key={row.key} className="inbox-item">
                  <Link to={row.to} className="inbox-row">
                    <StatusDot tone={row.tone} label={row.word} />
                    <span className="inbox-word">{row.word}</span>
                    <span className="inbox-subject">{row.subject}</span>
                  </Link>
                  {actionsOf === undefined ? null : (
                    <InboxActions row={row} actions={actionsOf(row)} />
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}
    </>
  );
}

function InboxActions(props: { readonly row: InboxRow; readonly actions: InboxRowActions }) {
  const { actions, row } = props;
  return (
    <span className="inbox-actions">
      {actions.fix === undefined ? null : (
        <Button variant="secondary" disabled={actions.fix.disabled} onClick={actions.fix.onSelect}>
          {actions.fix.label}
        </Button>
      )}
      {actions.menu.length === 0 ? null : (
        <RowMenu label={`Actions for ${row.subject}`} entries={actions.menu} />
      )}
    </span>
  );
}

// why: an address can name an item the daemon has since cleared; the drawer says so instead of
// keeping the details it last held.
function InboxDrawerBody({ shown }: { readonly shown: InboxPage["shown"] }) {
  if (typeof shown !== "object") {
    return <p className="muted drawer-note">This is no longer in the Inbox.</p>;
  }
  return (
    <div className="inbox-drawer">
      <section className="card inbox-what" aria-label="What happened">
        <p>
          <Status tone={shown.tone}>{shown.word}</Status>
        </p>
        <p>{shown.what}</p>
      </section>
      <div role="group" aria-label="Facts">
        <Facts facts={shown.facts} />
      </div>
      <ButtonLink to={shown.about.to}>{shown.about.open}</ButtonLink>
      <Panel title="Recent events" flush>
        <EventList events={shown.events} />
      </Panel>
    </div>
  );
}

function EventList({ events }: { readonly events: readonly InboxEvent[] }) {
  if (events.length === 0) return <Empty>No events in the last hour.</Empty>;
  return (
    <ul className="inbox-events">
      {events.map((event) => (
        <li key={event.key}>
          <Link to={event.to} className="inbox-event">
            <span className="mono muted">{event.time}</span>
            <span className={event.tone === undefined ? "mono" : `mono inbox-event-${event.tone}`}>
              {event.name}
            </span>
            <span className="inbox-event-text">{event.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
