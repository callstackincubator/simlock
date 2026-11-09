import { AgentChip, Meter, Pill, Ring } from "../../ds";
import type { LeaseRowView, LeaseSummary } from "../../state/leases";

// why: the pane's resting state: what the whole fleet of leases looks like, counted over every lease
// and not the table's page.
export function LeaseSummaryPane({ summary }: { readonly summary: LeaseSummary }) {
  return (
    <section className="card lease-pane lease-summary" aria-label="Lease summary">
      <h2 className="lease-section-head">
        <span>By holder</span>
        <span className="lease-section-end">
          {summary.total} {summary.total === 1 ? "lease" : "leases"}
        </span>
      </h2>
      {summary.holders.length === 0 ? (
        <p className="muted lease-note">No leases are held.</p>
      ) : (
        <ul className="lease-holders">
          {summary.holders.map((holder) => (
            <li key={holder.id}>
              <AgentChip kind={holder.kind} title={holder.id} />
              <span className="mono lease-ellipsis" title={holder.id}>
                {holder.display}
              </span>
              <Meter percent={holder.percent} tone="neutral" size="thin" />
              <span className="mono muted lease-holder-count">{holder.count}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.platforms.length === 0 ? null : (
        <>
          <h2 className="lease-section-head lease-section-rule">
            <span>By platform</span>
          </h2>
          <ul className="lease-platforms">
            {summary.platforms.map((platform) => (
              <li key={platform.platform}>
                <Ring size={46} percent={platform.percent} />
                <div>
                  <div className="lease-platform-name">{platform.label}</div>
                  <div className="muted lease-platform-note">
                    {platform.slots === undefined
                      ? `${platform.held} held`
                      : `${platform.held} of ${platform.slots} slots`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2 className="lease-section-head lease-section-rule">
        <span>Ending in 5 min</span>
        {summary.endingCount === 0 ? null : <Pill tone="warn">{summary.endingCount}</Pill>}
      </h2>
      {summary.ending.length === 0 ? (
        <p className="muted lease-note">Nothing ends in the next 5 minutes.</p>
      ) : (
        <ul className="lease-list">
          {summary.ending.map((row) => (
            <li key={row.key}>
              <AgentChip kind={row.holderKind} title={row.holderTitle} />
              <div className="lease-list-text">
                <div className="mono lease-ellipsis" title={row.holderTitle}>
                  {row.holderDisplay}
                </div>
                <div className="muted lease-ellipsis lease-list-sub" title={row.sub}>
                  {row.sub}
                </div>
              </div>
              <Countdown row={row} />
            </li>
          ))}
        </ul>
      )}
      <h2 className="lease-section-head lease-section-rule">
        <span>Longest held</span>
      </h2>
      {summary.longest.length === 0 ? (
        <p className="muted lease-note">No leases are held.</p>
      ) : (
        <ul className="lease-list">
          {summary.longest.map((row) => (
            <li key={row.key}>
              <AgentChip kind={row.holderKind} title={row.holderTitle} />
              <span className="mono lease-ellipsis lease-list-grow" title={row.holderTitle}>
                {row.holderDisplay}
              </span>
              <span className="muted lease-list-sub">renewed {row.renewedAgo}</span>
              <span className="mono lease-held">{row.held}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted lease-help">Select a lease to see its details and events here.</p>
    </section>
  );
}

function Countdown({ row }: { readonly row: LeaseRowView }) {
  return (
    <span className="lease-ttl">
      <span className="mono lease-warn">{row.remaining}</span>
      <Meter percent={row.percent} tone="warn" size="thin" />
    </span>
  );
}
