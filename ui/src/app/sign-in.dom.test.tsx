import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type Answer, type Call, type Routes, renderConsole } from "../test/console";

const OPERATOR_NEEDED = "That token is real, but the console needs an operator token.";
const NAV_LABELS = [
  "Overview",
  "Inbox",
  "Fleet",
  "Leases",
  "Queue",
  "Baselines",
  "Activity",
  "Usage",
];

// why: a daemon knows tokens by role: an operator's reads work and name it, an agent's or a worker's
// is refused with 403, and one it does not know with 401.
function daemonKnowing(
  operators: Readonly<Record<string, string>>,
  others: readonly string[] = [],
): Routes {
  const answer = (call: Call, ok: (name: string) => Answer): Answer => {
    const { bearer } = call;
    if (bearer !== undefined && Object.hasOwn(operators, bearer))
      return ok(operators[bearer] ?? "");
    if (bearer !== undefined && others.includes(bearer)) {
      return {
        body: { error: { code: "FORBIDDEN", message: "Operator role required" } },
        status: 403,
      };
    }
    return { body: { error: { code: "UNAUTHENTICATED", message: "Sign in" } }, status: 401 };
  };
  return {
    "/v1/healthz": { body: { status: "ok" } },
    "/v1/identity": (call) => answer(call, (name) => ({ body: { name } })),
    "/v1/workers": (call) => answer(call, () => ({ body: { workers: [] } })),
  };
}

const DAEMON = daemonKnowing({ tok_operator: "operator", tok_ci: "ci-runner" });

type Console = ReturnType<typeof renderConsole>;

async function signIn(view: Console, token: string): Promise<void> {
  await view.user.type(await screen.findByLabelText("Operator token"), token);
  await view.user.click(screen.getByRole("button", { name: "Sign in" }));
}

function consoleNav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Console" });
}

describe("signing in with a token", () => {
  it("an operator token signs in and shows the shell", async () => {
    const view = renderConsole({ routes: DAEMON, token: null });

    await signIn(view, "tok_operator");

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(
      within(consoleNav())
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(NAV_LABELS);
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Operator token")).not.toBeInTheDocument();
  });

  it("an operator token's label is shown in the sidebar as who is signed in", async () => {
    const view = renderConsole({ routes: DAEMON, token: null });

    await signIn(view, "tok_ci");

    expect(await screen.findByTitle("ci-runner")).toHaveTextContent("Signed in as ci-runner");
  });

  it("the navigation marks the current page, and the tab's title names it", async () => {
    const view = renderConsole({ path: "/" });
    const nav = consoleNav();
    expect(await within(nav).findByRole("link", { current: "page" })).toHaveTextContent("Overview");
    expect(document.title).toBe("Overview · Simlock");

    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await view.user.click(within(nav).getByRole("link", { name: "Activity" }));

    expect(within(nav).getByRole("link", { current: "page" })).toHaveTextContent("Activity");
    expect(document.title).toBe("Activity · Simlock");
  });

  it("the browser's back and forward move between the console's pages", async () => {
    const view = renderConsole({ path: "/" });
    const nav = consoleNav();
    await view.user.click(await within(nav).findByRole("link", { name: "Activity" }));
    await screen.findByRole("heading", { level: 1, name: "Activity" });

    window.history.back();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    });
    expect(within(nav).getByRole("link", { current: "page" })).toHaveTextContent("Overview");

    window.history.forward();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Activity" })).toBeInTheDocument();
    });
  });

  it("signing in with an empty field asks the daemon nothing", async () => {
    const view = renderConsole({ routes: DAEMON, token: null });
    const field = await screen.findByLabelText("Operator token");
    const asked = view.calls.length;

    await view.user.click(screen.getByRole("button", { name: "Sign in" }));
    await view.user.type(field, "   ");
    await view.user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(field).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.calls.slice(asked)).toEqual([]);
  });

  it("a token pasted with spaces around it signs in", async () => {
    const view = renderConsole({ routes: DAEMON, token: null });
    await view.user.click(await screen.findByLabelText("Operator token"));
    await view.user.paste("  tok_operator  ");

    await view.user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it.each(["agent", "worker"])(
    "a %s token is refused with a message that the console needs an operator token",
    async (role) => {
      const view = renderConsole({
        routes: daemonKnowing({}, [`tok_${role}`]),
        token: null,
      });

      await signIn(view, `tok_${role}`);

      expect(await screen.findByRole("alert")).toHaveTextContent(OPERATOR_NEEDED);
      expect(screen.getByLabelText("Operator token")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    },
  );

  it("an unknown token is refused", async () => {
    const view = renderConsole({ routes: DAEMON, token: null });

    await signIn(view, "slk_not-a-token-this-daemon-issued");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This daemon does not know that token.",
    );
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("a token the daemon revoked is signed out on the next reload", async () => {
    const first = renderConsole({ routes: DAEMON, token: null });
    await signIn(first, "tok_operator");
    expect(await screen.findByRole("button", { name: "Sign out" })).toBeInTheDocument();
    first.unmount();

    renderConsole({ routes: daemonKnowing({}), token: null });

    expect(await screen.findByLabelText("Operator token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("a reload keeps the operator signed in on the page it was on", async () => {
    const first = renderConsole({ routes: DAEMON, token: null });
    await signIn(first, "tok_operator");
    await first.user.click(await within(consoleNav()).findByRole("link", { name: "Leases" }));
    await screen.findByRole("heading", { level: 1, name: "Leases" });
    first.unmount();

    renderConsole({ path: "/leases", routes: DAEMON, token: null });

    expect(await screen.findByRole("heading", { level: 1, name: "Leases" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signing out returns to the sign-in screen, and a reload does not sign back in", async () => {
    const first = renderConsole({ routes: DAEMON, token: null });
    await signIn(first, "tok_operator");

    await first.user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Operator token")).toBeInTheDocument();
    first.unmount();

    renderConsole({ routes: DAEMON, token: null });

    expect(await screen.findByLabelText("Operator token")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
