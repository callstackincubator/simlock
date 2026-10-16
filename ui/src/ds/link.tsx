import {
  type AnchorHTMLAttributes,
  createContext,
  type MouseEvent,
  type ReactNode,
  useContext,
} from "react";

type Navigate = (to: string) => void;

// why: the design system knows nothing of the console's router; the app hands it the one way to
// move between pages, so a link here navigates without a reload wherever it is drawn.
const NavigateContext = createContext<Navigate | undefined>(undefined);

export function NavigationProvider(props: {
  readonly navigate: Navigate;
  readonly children: ReactNode;
}) {
  return (
    <NavigateContext.Provider value={props.navigate}>{props.children}</NavigateContext.Provider>
  );
}

const MODIFIER_KEYS = ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const;

type ClickKeys = Pick<MouseEvent, "button" | (typeof MODIFIER_KEYS)[number]>;

export function opensInThisTab(event: ClickKeys): boolean {
  return event.button === 0 && !MODIFIER_KEYS.some((key) => event[key]);
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly to: string;
}

export function Link({ onClick, to, ...rest }: LinkProps) {
  const navigate = useContext(NavigateContext);
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (navigate === undefined || !opensInThisTab(event)) return;
    event.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={follow} />;
}
