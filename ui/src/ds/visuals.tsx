import "./visuals.css";

import type { ReactNode } from "react";

import { Link } from "./link";
import { Meter } from "./meter";
import type { Tone } from "./status";

export function Pill({
  children,
  tone,
  plain = false,
}: {
  readonly children: ReactNode;
  readonly tone: Tone;
  readonly plain?: boolean;
}) {
  return (
    <span className={`pill ${plain ? "pill-plain" : `pill-${tone}`}`}>
      {plain ? null : <span className="pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Ring({
  percent,
  label,
  size = 54,
  tone = "neutral",
  bare = false,
}: {
  readonly percent?: number;
  readonly label: string;
  readonly size?: number;
  readonly tone?: Tone | "neutral";
  // why: a card that prints the figure's name beside the ring needs no second one under it.
  readonly bare?: boolean;
}) {
  const known = percent !== undefined && Number.isFinite(percent);
  const value = known ? `${percent}%` : "—";
  const width = Math.max(46, size);
  const radius = (width - 5) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = known ? Math.max(0, Math.min(100, percent)) / 100 : 0;
  return (
    <span className="ring-figure">
      <span className={`ring-box ring-${tone}`}>
        <svg width={width} height={width} aria-hidden="true">
          <circle className="ring-track" cx={width / 2} cy={width / 2} r={radius} />
          <circle
            className="ring-value"
            cx={width / 2}
            cy={width / 2}
            r={radius}
            strokeDasharray={`${circumference * fraction} ${circumference}`}
            transform={`rotate(-90 ${width / 2} ${width / 2})`}
          />
        </svg>
        <span className="ring-number">{value}</span>
      </span>
      {bare ? (
        <span className="visually-hidden">{label}</span>
      ) : (
        <span className="ring-label">{label}</span>
      )}
    </span>
  );
}

export function LogRow({
  time,
  status,
  event,
  subject,
  detail,
  tone,
}: {
  readonly time: ReactNode;
  readonly status: ReactNode;
  readonly event: ReactNode;
  readonly subject: ReactNode;
  readonly detail: ReactNode;
  readonly tone?: Tone;
}) {
  return (
    <div className={`visual-log${tone ? ` visual-log-${tone}` : ""}`}>
      <span>{time}</span>
      <span>{status}</span>
      <span>{event}</span>
      <span>{subject}</span>
      <span>{detail}</span>
    </div>
  );
}

export function FeedRow({
  icon,
  event,
  subject,
  detail,
  worker,
  time,
}: {
  readonly icon: ReactNode;
  readonly event: ReactNode;
  readonly subject: ReactNode;
  readonly detail: ReactNode;
  readonly worker: ReactNode;
  readonly time: ReactNode;
}) {
  return (
    <div className="visual-feed">
      <span className="visual-feed-icon">{icon}</span>
      <span className="visual-feed-content">
        <span className="visual-feed-event">{event}</span> <span>{subject}</span>{" "}
        <span>{detail}</span> <span className="visual-feed-worker">{worker}</span>
      </span>
      <span className="visual-feed-time">{time}</span>
    </div>
  );
}

export function GroupHeader({
  children,
  count,
}: {
  readonly children: ReactNode;
  readonly count?: ReactNode;
}) {
  return (
    <div className="visual-group">
      {children}
      {count === undefined ? null : <span className="visual-group-count">{count}</span>}
    </div>
  );
}

export function Banner({
  count,
  title,
  detail,
  action,
}: {
  readonly count: ReactNode;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly action: ReactNode;
}) {
  return (
    <div className="visual-banner">
      <span className="visual-banner-count">{count}</span>
      <span className="visual-banner-content">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      {action}
    </div>
  );
}

export function WorkerTile({
  name,
  title,
  to,
  pill,
  ios,
  android,
  leased,
  cpu,
  memory,
  disk,
  cpuTone = "neutral",
  memoryTone = "neutral",
  diskTone = "neutral",
}: {
  readonly name: string;
  readonly title: string;
  readonly to: string;
  readonly pill?: ReactNode;
  readonly ios: ReactNode;
  readonly android: ReactNode;
  readonly leased: ReactNode;
  readonly cpu?: number;
  readonly memory?: number;
  readonly disk?: number;
  readonly cpuTone?: Tone | "neutral";
  readonly memoryTone?: Tone | "neutral";
  readonly diskTone?: Tone | "neutral";
}) {
  return (
    <div className="worker-tile">
      <Link className="worker-tile-name" to={to} title={title}>
        {name}
      </Link>
      {pill === undefined ? null : <div>{pill}</div>}
      <div className="worker-tile-slots">
        <span>{ios}</span>
        <span className="worker-tile-divider" aria-hidden="true" />
        <span>{android}</span>
        <span className="worker-tile-fraction">{leased}</span>
      </div>
      <div className="worker-tile-metrics">
        <WorkerMetric label="CPU" percent={cpu} tone={cpuTone} />
        <WorkerMetric label="MEM" percent={memory} tone={memoryTone} />
        <WorkerMetric label="DISK" percent={disk} tone={diskTone} />
      </div>
    </div>
  );
}

function WorkerMetric({
  label,
  percent,
  tone,
}: {
  readonly label: string;
  readonly percent: number | undefined;
  readonly tone: Tone | "neutral";
}) {
  const known = percent !== undefined && Number.isFinite(percent);
  return (
    <div className="worker-metric">
      <span>{label}</span>
      {known ? (
        <Meter percent={percent} tone={tone} size="thin" />
      ) : (
        <span className="worker-metric-empty" />
      )}
      <span>{known ? `${percent}%` : "—"}</span>
    </div>
  );
}
