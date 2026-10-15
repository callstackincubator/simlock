import { useEffect } from "react";

import { AppFrame, Button, Icon, Sidebar, Status, StatusDot } from "../ds";
import { NotFoundScreen } from "../screens/not-found";
import { usePath } from "../state/router";
import { useAttentionCount, useConnectionStatus, useSignOut, useTokenCheck } from "../state/shell";
import { useSidebar } from "../state/sidebar";
import { ROUTES, routeFor } from "./routes";

export function Shell() {
  const path = usePath();
  const route = routeFor(path);
  const attention = useAttentionCount();
  const sidebar = useSidebar();
  useTokenCheck();

  useEffect(() => {
    document.title = route === undefined ? "Simlock" : `${route.label} · Simlock`;
  }, [route]);

  const entries = ROUTES.map((entry) => ({
    current: entry === route,
    icon: entry.icon,
    label: entry.label,
    to: entry.path,
    ...(entry.path === "/attention" && attention !== undefined
      ? { alert: true, count: attention }
      : {}),
  }));

  return (
    <AppFrame
      sidebar={
        <Sidebar
          entries={entries}
          collapsed={sidebar.collapsed}
          onToggle={sidebar.toggle}
          footer={(collapsed) => <SidebarFoot collapsed={collapsed} />}
        />
      }
    >
      {route === undefined ? <NotFoundScreen /> : <route.Screen />}
    </AppFrame>
  );
}

// why: the connection's word is a live region so a screen reader hears it change; the data's age
// beside it ticks every second, so it stays outside the region.
function SidebarFoot({ collapsed }: { readonly collapsed: boolean }) {
  const status = useConnectionStatus();
  const signOut = useSignOut();
  return (
    <>
      <div className="connection">
        {collapsed ? (
          <>
            <StatusDot tone={status.tone} label={status.word} />
            <span role="status" className="visually-hidden">
              {status.word}
            </span>
          </>
        ) : (
          <Status tone={status.tone}>
            <span role="status">{status.word}</span>
            {status.age === undefined ? null : <span> — data from {status.age} ago</span>}
          </Status>
        )}
      </div>
      <Button
        variant="secondary"
        className="sign-out"
        onClick={signOut}
        aria-label="Sign out"
        title="Sign out"
      >
        <Icon name="signOut" />
        <span className="nav-label">Sign out</span>
      </Button>
    </>
  );
}
