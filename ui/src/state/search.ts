import { useCallback, useState } from "react";

export interface SearchPalette {
  readonly open: boolean;
  readonly show: () => void;
  readonly hide: () => void;
}

export function useSearchPalette(): SearchPalette {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return { hide, open, show };
}
