import { createContext, type ReactNode, useContext } from "react";

import type { ApiClient, Fetch } from "../data/api";
import type { Preferences } from "../data/preferences";
import type { Session } from "../data/session";
import type { ConfirmSpec, ToastSpec } from "../ds";

interface ConsoleServices {
  readonly api: ApiClient;
  readonly fetch: Fetch;
  readonly preferences: Preferences;
  readonly session: Session;
  // why: plain functions the app passes in, so state raises a toast or a dialog without knowing
  // what draws it.
  readonly notify: (toast: ToastSpec) => void;
  readonly confirm: (spec: ConfirmSpec, work: () => Promise<void>) => Promise<void>;
}

const ConsoleContext = createContext<ConsoleServices | undefined>(undefined);

export function ConsoleProvider(props: ConsoleServices & { readonly children: ReactNode }) {
  const { children, ...services } = props;
  return <ConsoleContext.Provider value={services}>{children}</ConsoleContext.Provider>;
}

function useServices(): ConsoleServices {
  const services = useContext(ConsoleContext);
  if (services === undefined) throw new Error("Console services used outside ConsoleProvider");
  return services;
}

export function useApi(): ApiClient {
  return useServices().api;
}

export function useSession(): Session {
  return useServices().session;
}

export function useFetch(): Fetch {
  return useServices().fetch;
}

export function usePreferences(): Preferences {
  return useServices().preferences;
}

export function useNotify(): ConsoleServices["notify"] {
  return useServices().notify;
}

export function useConfirm(): ConsoleServices["confirm"] {
  return useServices().confirm;
}
