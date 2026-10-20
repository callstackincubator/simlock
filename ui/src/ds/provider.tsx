import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";

// why: Base UI draws a `<style>` element in two parts, and the console's CSP (`style-src 'self'`)
// refuses it; this switch turns both off, so the whole console stands under it.
export function DesignProvider({ children }: { readonly children: ReactNode }) {
  return <CSPProvider disableStyleElements>{children}</CSPProvider>;
}
