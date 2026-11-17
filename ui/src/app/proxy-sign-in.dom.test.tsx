import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Answer, type Call, type Handler, type Routes, renderConsole } from "../test/console";
import { device, lease, leaseDetails, NOW, worker } from "../test/fixtures";
import { returnToTab } from "../test/tab";

const EXPIRED_LINE =
  "Your sign-in proxy's identity was refused: it has expired. You can still sign in with an operator token.";
const SIGNED_OUT_URL = "https://proxy.example.test/signed-out";

type Mode = "signed-in" | "expired" | "redirect" | "html";

// why: a sign-in proxy stands in front of the daemon. Signed in, it adds the person's identity to a
// call with no token; expired, the daemon refuses that identity; at the end of its own session it
// answers its login page, or redirects to it, which `fetch` cannot follow. A call that carries an
// operator token is not the proxy's to judge.
function proxyDaemon(options: { readonly signOutUrl?: string } = { signOutUrl: SIGNED_OUT_URL }) {
  const state: {
    mode: Mode;
    held: Promise<void> | undefined;
    operators: Record<string, string>;
  } = { held: undefined, mode: "signed-in", operators: { tok_ci: "ci-runner" } };

  const behind =
    (ok: (call: Call) => Answer): Handler =>
    async (call) => {
      if (call.bearer !== undefined) {
        const name = state.operators[call.bearer];
        return name === undefined
          ? { body: { error: { code: "UNAUTHENTICATED", message: "Unknown token" } }, status: 401 }
          : ok(call);
      }
      switch (state.mode) {
        case "expired":
          return {
            body: { error: { code: "UNAUTHENTICATED", message: "Sign in", reason: "expired" } },
            status: 401,
          };
        case "html":
          return { body: "<h1>Proxy sign-in</h1>", status: 403 };
        case "redirect":
          throw new TypeError("Failed to fetch");
        case "signed-in":
          if (call.path === "/v1/identity") await state.held;
          return ok(call);
      }
    };

  const routes: Routes = {
    "/v1/baselines": behind(() => ({ body: { baselines: [] } })),
    "/v1/events": behind(() => ({ body: { events: [] } })),
    "/v1/healthz": { body: { status: "ok" } },
    "/v1/identity": behind((call) => ({
      body:
        call.bearer === undefined
          ? {
              name: "Alice",
              ...(options.signOutUrl === undefined ? {} : { signOutUrl: options.signOutUrl }),
              via: "proxy",
            }
          : { name: state.operators[call.bearer] },
    })),
    "/v1/inbox": behind(() => ({ body: { items: [] } })),
    "/v1/lease-requests": behind(() => ({ body: { requests: [] } })),
    "/v1/leases": behind(() => ({ body: { leases: [] } })),
    "/v1/workers": behind(() => ({ body: { workers: [] } })),
  };
  return { routes, state };
}

function signedInAs(name: string): HTMLElement {
  const label = screen.getByTitle(name);
  expect(label).toHaveTextContent(`Signed in as ${name}`);
  return label;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signing in through a proxy", () => {
  it("the console opens on Overview with no token form, reading who is signed in", async () => {
    const proxy = proxyDaemon();
    const view = renderConsole({ routes: proxy.routes, token: null });

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Operator token")).not.toBeInTheDocument();
    signedInAs("Alice");

    const nav = screen.getByRole("navigation", { name: "Console" });
    await view.user.click(within(nav).getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByText("Signed in as", { exact: false })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Sign out" })).toHaveAttribute(
      "title",
      "Sign out (Alice)",
    );
  });

  it("the page shows Signing in… and no token form while the identity answer is held", async () => {
    const proxy = proxyDaemon();
    let release: () => void = () => undefined;
    proxy.state.held = new Promise<void>((resolve) => (release = resolve));
    renderConsole({ routes: proxy.routes, token: null });

    expect(await screen.findByRole("heading", { level: 1, name: "Signing in…" })).toBeVisible();
    expect(screen.queryByLabelText("Operator token")).not.toBeInTheDocument();
    release();

    await waitFor(() => signedInAs("Alice"));
  });

  it("Sign out goes to the proxy's sign-out address when one is set", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const proxy = proxyDaemon();
    const view = renderConsole({ routes: proxy.routes, token: null });

    await view.user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(assign).toHaveBeenCalledExactlyOnceWith(SIGNED_OUT_URL);
  });

  it("there is no Sign out button when no sign-out address is set", async () => {
    const proxy = proxyDaemon({});
    renderConsole({ routes: proxy.routes, token: null });

    await waitFor(() => signedInAs("Alice"));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("an expired identity is said so on the token form, a labelled operator token opens the console, and its Sign out lands in the proxy session", async () => {
    const proxy = proxyDaemon();
    proxy.state.mode = "expired";
    const view = renderConsole({ routes: proxy.routes, token: null });

    expect(await screen.findByRole("alert")).toHaveTextContent(EXPIRED_LINE);
    await view.user.type(screen.getByLabelText("Operator token"), "tok_ci");
    await view.user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => signedInAs("ci-runner"));
    proxy.state.mode = "signed-in";
    await view.user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => signedInAs("Alice"));
    expect(screen.queryByLabelText("Operator token")).not.toBeInTheDocument();
  });

  it("an identity that expires while signed in takes the next request to the token form with that line", async () => {
    const proxy = proxyDaemon();
    renderConsole({ routes: proxy.routes, token: null });
    await waitFor(() => signedInAs("Alice"));

    // why: the console reads again when the operator returns to the tab, so the next request can
    // come before any click.
    proxy.state.mode = "expired";
    await returnToTab();

    expect(await screen.findByLabelText("Operator token")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(EXPIRED_LINE);
  });

  it.each(["html", "redirect"] as const)(
    "the proxy's own session ending in %s reloads the page, and a second ending within 60 seconds shows Your sign-in has ended.",
    async (ending) => {
      const reload = vi.fn();
      const proxy = proxyDaemon();
      renderConsole({ reload, routes: proxy.routes, token: null });
      await waitFor(() => signedInAs("Alice"));

      proxy.state.mode = ending;
      await returnToTab();
      await waitFor(() => expect(reload).toHaveBeenCalledOnce());
      expect(screen.queryByText("Your sign-in has ended.")).not.toBeInTheDocument();

      await returnToTab();

      expect(await screen.findByText("Your sign-in has ended.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Sign in again" })).toBeVisible();
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("revoking the token a person signed in with takes the console to the proxy session", async () => {
    const proxy = proxyDaemon();
    proxy.state.mode = "expired";
    const first = renderConsole({ routes: proxy.routes, token: null });
    await first.user.type(await screen.findByLabelText("Operator token"), "tok_ci");
    await first.user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    first.unmount();
    proxy.state.mode = "signed-in";
    delete proxy.state.operators["tok_ci"];

    renderConsole({ routes: proxy.routes, token: null });

    await waitFor(() => signedInAs("Alice"));
    expect(screen.queryByLabelText("Operator token")).not.toBeInTheDocument();
  });

  it("a release succeeds when signed in through the proxy", async () => {
    const held = new Map([["lse_1", "proxy-agent"]]);
    const proxy = proxyDaemon();
    const view = renderConsole({
      path: "/leases",
      routes: {
        ...proxy.routes,
        "/v1/leases": () => ({
          body: {
            leases: [...held].map(([id, requesterId]) => lease({ id, requesterId })),
          },
        }),
        "/v1/leases/*": { body: { lease: leaseDetails() } },
        "/v1/workers": {
          body: { workers: [worker({ devices: [device()], label: "mac-studio-01" })] },
        },
        "DELETE /v1/leases/*": (call) => {
          held.delete(call.path.split("/").at(-1) ?? "");
          return { body: {}, status: 202 };
        },
      },
      token: null,
    });
    await waitFor(() => signedInAs("Alice"));

    await view.user.click(await screen.findByRole("link", { name: "proxy-agent" }));
    const pane = await screen.findByRole("region", { name: "Lease" });
    await view.user.click(await within(pane).findByRole("button", { name: "Release" }));
    await view.user.click(
      within(
        await screen.findByRole("alertdialog", { name: "Release proxy-agent's lease?" }),
      ).getByRole("button", { name: "Release lease" }),
    );

    expect(await screen.findByText("Released proxy-agent's lease")).toBeVisible();
    expect(view.callsTo("DELETE", "/v1/leases/lse_1")).toHaveLength(1);
    view.events.push("lease.released", {
      event: "lease.released",
      id: "evt_r",
      payload: { leaseId: "lse_1" },
      seq: 1,
      timestamp: NOW,
    });
    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "proxy-agent" })).not.toBeInTheDocument();
    });
  });
});
