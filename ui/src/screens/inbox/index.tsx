import "./inbox.css";

import { ChoiceChips, Empty, Link, Loaded, Page, Panel, StatusDot, Toolbar } from "../../ds";
import { INBOX_FILTERS, type InboxFilter, type InboxRow, useInbox } from "../../state/inbox";

const GROUP_ORDER = ["Broken", "Needs a look", "Heads-up"] as const;

export function InboxScreen() {
  const { choose, filter, rows, view } = useInbox();
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
      <Loaded view={view}>{(page) => <InboxBody rows={rows(page)} filter={filter} />}</Loaded>
    </Page>
  );
}

export function InboxBody(props: {
  readonly rows: readonly InboxRow[];
  readonly filter: InboxFilter;
}) {
  const { filter, rows } = props;
  if (rows.length === 0) {
    return <Empty>{filter === "all" ? "Nothing needs you." : "Nothing in this group."}</Empty>;
  }
  return (
    <>
      {GROUP_ORDER.map((group) => {
        const inGroup = rows.filter((row) => row.group === group);
        return inGroup.length === 0 ? null : (
          <Panel key={group} title={group} flush>
            <ul className="inbox-list">
              {inGroup.map((row) => (
                <li key={row.key}>
                  <Link to={row.to} className="inbox-row">
                    <StatusDot tone={row.tone} label={row.word} />
                    <span className="inbox-word">{row.word}</span>
                    <span className="inbox-subject">{row.subject}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}
    </>
  );
}
