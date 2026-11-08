import type { ReactNode } from "react";

import type { Tone } from "./status";

export function Pill(_props: {
  readonly children: ReactNode;
  readonly tone: Tone;
  readonly plain?: boolean;
}) {
  return null;
}

export function Ring(_props: {
  readonly percent?: number;
  readonly label: string;
  readonly size?: number;
  readonly tone?: Tone | "neutral";
}) {
  return null;
}

export function LogRow(_props: {
  readonly time: ReactNode;
  readonly status: ReactNode;
  readonly event: ReactNode;
  readonly subject: ReactNode;
  readonly detail: ReactNode;
  readonly tone?: Tone;
}) {
  return null;
}

export function FeedRow(_props: {
  readonly icon: ReactNode;
  readonly event: ReactNode;
  readonly subject: ReactNode;
  readonly detail: ReactNode;
  readonly worker: ReactNode;
  readonly time: ReactNode;
}) {
  return null;
}

export function GroupHeader(_props: { readonly children: ReactNode; readonly count?: ReactNode }) {
  return null;
}

export function Banner(_props: {
  readonly count: ReactNode;
  readonly title: ReactNode;
  readonly detail: ReactNode;
  readonly action: ReactNode;
}) {
  return null;
}

export function WorkerTile(_props: {
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
}) {
  return null;
}
