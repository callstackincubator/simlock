const PATHS = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  workers: "M2 3h12v4H2zM2 9h12v4H2zM4.5 5h.01M4.5 11h.01",
  leases: "M5 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 9l6-6M11 5l2 2",
  waiting: "M2 4h12M2 8h9M2 12h6",
  baselines: "M8 2l6 3-6 3-6-3zM2 8l6 3 6-3M2 11l6 3 6-3",
  inbox: "M2 9l2-6h8l2 6v4H2zM2 9h3.5l1 2h3l1-2H14",
  events: "M1.5 8h3l2-5 3 10 2-5h3",
  usage: "M2 14h12M4.5 14V8M8 14V3M11.5 14v-4",
  collapse: "M2 2.5h12v11H2zM6 2.5v11M11.5 6L9.5 8l2 2",
  expand: "M2 2.5h12v11H2zM6 2.5v11M9.5 6l2 2-2 2",
  menu: "M2 4h12M2 8h12M2 12h12",
  close: "M3 3l10 10M13 3L3 13",
  signOut: "M6 2H3v12h3M7 8h7M11 5l3 3-3 3",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  device: "M5 1.5h6v13H5zM7.5 12.5h1",
  info: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.5v4M8 5h.01",
  settings:
    "M7.0 3.1L7.1 1.3L8.9 1.3L9.0 3.1L10.7 3.8L12.1 2.6L13.4 3.9L12.2 5.3L12.9 7.0L14.7 7.1L14.7 8.9L12.9 9.0L12.2 10.7L13.4 12.1L12.1 13.4L10.7 12.2L9.0 12.9L8.9 14.7L7.1 14.7L7.0 12.9L5.3 12.2L3.9 13.4L2.6 12.1L3.8 10.7L3.1 9.0L1.3 8.9L1.3 7.1L3.1 7.0L3.8 5.3L2.6 3.9L3.9 2.6L5.3 3.8zM8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5L14 14",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { readonly name: IconName }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
