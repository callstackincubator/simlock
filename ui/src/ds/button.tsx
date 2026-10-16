import "./button.css";

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Link } from "./link";

export type ButtonVariant = "primary" | "secondary" | "quiet";

function classOf(variant: ButtonVariant): string {
  return variant === "primary" ? "button" : `button button-${variant}`;
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: ButtonVariant },
) {
  const { variant = "secondary", type = "button", className, ...rest } = props;
  const base = classOf(variant);
  return (
    <button
      {...rest}
      type={type}
      className={className === undefined ? base : `${base} ${className}`}
    />
  );
}

export function ButtonLink(props: {
  readonly to: string;
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}) {
  const { children, to, variant = "secondary" } = props;
  return (
    <Link to={to} className={classOf(variant)}>
      {children}
    </Link>
  );
}
