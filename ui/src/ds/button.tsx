import "./button.css";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Link } from "./link";

export type ButtonVariant = "primary" | "secondary" | "quiet";

function classOf(variant: ButtonVariant, small = false): string {
  const base = variant === "primary" ? "button" : `button button-${variant}`;
  return small ? `${base} button-sm` : base;
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: ButtonVariant;
    readonly small?: boolean;
  },
) {
  const { variant = "secondary", small = false, type = "button", className, ...rest } = props;
  const base = classOf(variant, small);
  return (
    <button
      {...rest}
      type={type}
      className={className === undefined ? base : `${base} ${className}`}
    />
  );
}

// why: a button that holds an icon alone has no text, so its name comes from the caller's
// `aria-label`; Base UI passes its own props and ref through, so it can render as this.
export function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className, type = "button", ...rest } = props;
  return (
    <button
      {...rest}
      type={type}
      className={className === undefined ? "icon-button" : `icon-button ${className}`}
    />
  );
}

// why: a link to another site opens in a tab of its own and never goes through the console's router.
export function ButtonLink(props: {
  readonly to: string;
  readonly variant?: ButtonVariant;
  readonly small?: boolean;
  readonly children: ReactNode;
}) {
  const { children, small = false, to, variant = "secondary" } = props;
  if (/^https?:\/\//.test(to)) {
    return (
      <a href={to} className={classOf(variant, small)} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={classOf(variant, small)}>
      {children}
    </Link>
  );
}
