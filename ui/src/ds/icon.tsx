const PATHS = {
  overview: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z",
  workers: "M2 3h12v4H2zM2 9h12v4H2zM5 5h.01M5 11h.01",
  leases: "M10 2a4 4 0 1 1-3.5 6L2 12.5V14h2v-1.5h1.5V11h1.5l1-1",
  waiting: "M2 4h12M2 8h9M2 12h6",
  attention: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01",
  events: "M1.5 8h3l2-5 3 10 2-5h3",
  collapse: "M2 2.5h12v11H2zM6 2.5v11M11.5 6L9.5 8l2 2",
  expand: "M2 2.5h12v11H2zM6 2.5v11M9.5 6l2 2-2 2",
  menu: "M2 4h12M2 8h12M2 12h12",
  close: "M3 3l10 10M13 3L3 13",
  signOut: "M6 2.5H2.5v11H6M10 5l3 3-3 3M13 8H6",
  device: "M5 1.5h6v13H5zM7.5 12.5h1",
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
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
