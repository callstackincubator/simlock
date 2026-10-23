import { useCallback, useSyncExternalStore } from "react";

import { ApiError } from "../data/api";
import type { MenuEntry, ToastSpec } from "../ds";
import type { ItemAction } from "../model/actions";
import { navigate } from "./router";
import { useApi, useConfirm, useNotify } from "./services";

// why: the in-flight flag is kept per item key, outside any component, so every surface that offers
// an item's actions (its row, its drawer, the Inbox) sees the same flag and disables the same entries.
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

function setInFlight(key: string, on: boolean): void {
  if (on) inFlight.add(key);
  else inFlight.delete(key);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let snapshot: ReadonlySet<string> = new Set();
function current(): ReadonlySet<string> {
  if (snapshot.size !== inFlight.size || [...inFlight].some((key) => !snapshot.has(key))) {
    snapshot = new Set(inFlight);
  }
  return snapshot;
}

export interface Actions {
  readonly run: (action: ItemAction) => Promise<void>;
  readonly entries: (actions: readonly ItemAction[]) => readonly MenuEntry[];
}

// why: the toast an action earns: its outcome (or success) words, the view link, or Undo.
function successToast(
  action: ItemAction,
  answer: unknown,
  run: (action: ItemAction) => Promise<void>,
): ToastSpec {
  const { description, title, view } = action.outcome?.(answer) ?? action.success;
  const { undo } = action;
  return {
    title,
    ...(description === undefined ? {} : { description }),
    ...(view === undefined
      ? {}
      : { action: { label: view.label, onClick: () => navigate(view.to) } }),
    ...(undo === undefined
      ? {}
      : {
          action: {
            label: "Undo",
            onClick: () => {
              void run(undo);
            },
          },
        }),
  };
}

export function useActions(): Actions {
  const api = useApi();
  const confirm = useConfirm();
  const notify = useNotify();
  const busy = useSyncExternalStore(subscribe, current, current);
  const run = useCallback(
    async (action: ItemAction): Promise<void> => {
      if (inFlight.has(action.itemKey)) return;
      const perform = async (): Promise<void> => {
        if (inFlight.has(action.itemKey)) return;
        setInFlight(action.itemKey, true);
        try {
          const answer = await api.write(action.method, action.path, {
            ...(action.body === undefined ? {} : { body: action.body }),
            ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
          });
          notify(successToast(action, answer, run));
        } catch (error: unknown) {
          // why: a 401 has already signed the session out, and that is not a toast.
          if (error instanceof ApiError && error.status === 401) return;
          notify({
            action: {
              label: "Retry",
              onClick: () => {
                void perform();
              },
            },
            // why: anything but the daemon's own refusal is a write that got no answer (a dropped
            // connection or the client's timeout).
            description: error instanceof ApiError ? error.message : "The daemon did not answer.",
            title: action.failure,
            tone: "error",
          });
        } finally {
          setInFlight(action.itemKey, false);
        }
      };
      if (action.confirm === undefined) await perform();
      else await confirm(action.confirm, perform);
    },
    [api, confirm, notify],
  );
  const entries = useCallback(
    (actions: readonly ItemAction[]) =>
      actions.map((action) => ({
        danger: action.danger,
        disabled: busy.has(action.itemKey),
        key: action.id,
        label: action.label,
        onSelect: () => {
          void run(action);
        },
      })),
    [busy, run],
  );
  return { entries, run };
}
