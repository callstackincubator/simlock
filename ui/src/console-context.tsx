import { createContext, type ReactNode, useContext } from "react";

import type { ApiClient } from "./api";
import type { Session } from "./session";

interface ConsoleServices {
  readonly api: ApiClient;
  readonly session: Session;
}

const ConsoleContext = createContext<ConsoleServices | undefined>(undefined);

export function ConsoleProvider(props: ConsoleServices & { readonly children: ReactNode }) {
  const { api, children, session } = props;
  return <ConsoleContext.Provider value={{ api, session }}>{children}</ConsoleContext.Provider>;
}

function useServices(): ConsoleServices {
  const services = useContext(ConsoleContext);
  if (services === undefined) throw new Error("Console services used outside ConsoleProvider");
  return services;
}

/** The daemon's API for the signed-in operator. Every view reads its data through this. */
// fallow-ignore-next-line unused-export -- the read path every data view uses; the shell itself shows none yet.
export function useApi(): ApiClient {
  return useServices().api;
}

export function useSession(): Session {
  return useServices().session;
}
