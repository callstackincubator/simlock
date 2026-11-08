import "./visuals.css";

import type { CSSProperties, ReactNode } from "react";

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
  stroke = 5,
  showNumber = true,
}: {
  readonly percent?: number | undefined;
  readonly label?: string;
  readonly size?: number;
  readonly tone?: Tone | "neutral";
  // why: a ring beside its own caption keeps the label for a screen reader only.
  readonly bare?: boolean;
  // why: a ring beside its own figure (a countdown) draws a thicker line and leaves the number out.
  readonly stroke?: number;
  readonly showNumber?: boolean;
}) {
  const known = percent !== undefined && Number.isFinite(percent);
  const value = known ? `${percent}%` : "—";
  const width = Math.max(46, size);
  const radius = (width - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = known ? Math.max(0, Math.min(100, percent)) / 100 : 0;
  return (
    <span className="ring-figure">
      <span
        className={`ring-box ring-${tone}`}
        style={{ "--ring-stroke": `${stroke}px` } as CSSProperties}
      >
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
        {showNumber ? <span className="ring-number">{value}</span> : null}
      </span>
      {label === undefined ? null : (
        <span className={bare ? "ring-label visually-hidden" : "ring-label"}>{label}</span>
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
  tone,
}: {
  readonly tone?: Tone | undefined;
  readonly icon: ReactNode;
  readonly event: ReactNode;
  readonly subject: ReactNode;
  readonly detail: ReactNode;
  readonly worker: ReactNode;
  readonly time: ReactNode;
}) {
  return (
    <div className="visual-feed">
      <span
        className={
          tone === undefined ? "visual-feed-icon" : `visual-feed-icon visual-feed-icon-${tone}`
        }
      >
        {icon}
      </span>
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
