import "./toast.css";

import { Toast } from "@base-ui/react/toast";

export interface ToastSpec {
  readonly tone?: "error";
  readonly title: string;
  readonly description?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

export interface Toaster {
  readonly notify: (spec: ToastSpec) => void;
  readonly manager: ReturnType<typeof Toast.createToastManager>;
}

// why: Base UI's manager is the only toast queue: it owns the timer, the limit and closing.
export function createToaster(): Toaster {
  const manager = Toast.createToastManager();
  return {
    manager,
    notify(spec) {
      const id = manager.add({
        title: spec.title,
        // why: an error toast stays until it is closed and is announced at once.
        ...(spec.tone === "error" ? { priority: "high" as const, timeout: 0, type: "error" } : {}),
        ...(spec.description === undefined ? {} : { description: spec.description }),
        ...(spec.action === undefined
          ? {}
          : {
              actionProps: {
                children: spec.action.label,
                onClick: () => {
                  spec.action?.onClick();
                  manager.close(id);
                },
              },
            }),
      });
    },
  };
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root key={toast.id} toast={toast} className="toast">
      <Toast.Content className="toast-content">
        <Toast.Title className="toast-title" />
        <Toast.Description className="toast-description" />
        <Toast.Action className="button button-secondary toast-action" />
      </Toast.Content>
    </Toast.Root>
  ));
}

export function ToastHost({ toaster }: { readonly toaster: Toaster }) {
  return (
    <Toast.Provider toastManager={toaster.manager} limit={3} timeout={6000}>
      <Toast.Portal>
        <Toast.Viewport className="toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
