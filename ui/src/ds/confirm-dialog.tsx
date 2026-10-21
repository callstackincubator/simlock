import "./confirm-dialog.css";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "./button";

export interface ConfirmSpec {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  readonly busy: string;
  readonly typeToConfirm?: string;
}

// why: `work` runs while the dialog stays open, its button disabled and worded `busy`, so a second
// click sends nothing; keeping the dialog out of the list that opened it lets a refetch drop the
// row without closing it.
export interface Confirmer {
  readonly confirm: (spec: ConfirmSpec, work: () => Promise<void>) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => Pending | undefined;
}

export interface Pending {
  readonly spec: ConfirmSpec;
  readonly busy: boolean;
  readonly answer: (confirmed: boolean) => void;
}

export function createConfirmer(): Confirmer {
  let pending: Pending | undefined;
  const listeners = new Set<() => void>();
  const set = (next: Pending | undefined) => {
    pending = next;
    for (const listener of listeners) listener();
  };
  return {
    confirm: (spec, work) =>
      new Promise<void>((resolve) => {
        const answer = (confirmed: boolean) => {
          if (!confirmed) {
            set(undefined);
            resolve();
            return;
          }
          set({ answer, busy: true, spec });
          void work().finally(() => {
            set(undefined);
            resolve();
          });
        };
        set({ answer, busy: false, spec });
      }),
    snapshot: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// why: the typed text belongs to one opening of the dialog, so each item asked about gets a fresh
// field, and the confirming button waits for the exact name.
function TypedName(props: {
  readonly name: string;
  readonly typed: string;
  readonly onType: (typed: string) => void;
}) {
  const id = useId();
  return (
    <div className="confirm-typed">
      <label htmlFor={id}>{` Type ${props.name} to confirm.`}</label>
      <input
        id={id}
        className="confirm-input"
        value={props.typed}
        autoComplete="off"
        onChange={(event) => props.onType(event.target.value)}
      />
    </div>
  );
}

function ConfirmActions(props: { readonly shown: Pending; readonly typed: string }) {
  const { shown, typed } = props;
  const { busy, spec } = shown;
  const waitingForName = spec.typeToConfirm !== undefined && typed !== spec.typeToConfirm;
  return (
    <div className="confirm-actions">
      <Button variant="secondary" disabled={busy} onClick={() => shown.answer(false)}>
        Keep
      </Button>
      <Button
        variant="primary"
        className="confirm-danger"
        disabled={busy || waitingForName}
        onClick={() => shown.answer(true)}
      >
        {busy ? spec.busy : spec.confirm}
      </Button>
    </div>
  );
}

export function ConfirmHost({ confirmer }: { readonly confirmer: Confirmer }) {
  const pending = useSyncExternalStore(confirmer.subscribe, confirmer.snapshot);
  const [last, setLast] = useState<Pending | undefined>(undefined);
  const [typed, setTyped] = useState("");
  if (pending !== undefined && pending.spec !== last?.spec) setTyped("");
  if (pending !== undefined && pending !== last) setLast(pending);
  const shown = pending ?? last;
  if (shown === undefined) return null;
  const { busy, spec } = shown;
  return (
    <AlertDialog.Root
      open={pending !== undefined}
      onOpenChange={(open) => {
        if (!open && !busy) shown.answer(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="confirm-dim" />
        <AlertDialog.Popup className="confirm">
          <AlertDialog.Title className="confirm-title">{spec.title}</AlertDialog.Title>
          <AlertDialog.Description className="confirm-body">{spec.body}</AlertDialog.Description>
          {spec.typeToConfirm === undefined ? null : (
            <TypedName name={spec.typeToConfirm} typed={typed} onType={setTyped} />
          )}
          <ConfirmActions shown={shown} typed={typed} />
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
