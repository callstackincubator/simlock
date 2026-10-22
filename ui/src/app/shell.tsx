import { useEffect } from "react";

import { AppFrame, Button, CommandPalette, Icon, Sidebar, Status, StatusDot } from "../ds";
import { NotFoundScreen } from "../screens/not-found";
import { usePath } from "../state/router";
import { useSearchPalette, useSearchSession } from "../state/search";
import {
  useInboxCount,
  useConnectionStatus,
  useSignedIn,
  useSignOut,
  useTokenCheck,
} from "../state/shell";
import { useSidebar } from "../state/sidebar";
import { ROUTES, routeFor } from "./routes";

const PAGES = ROUTES.map((route) => ({ label: route.label, path: route.path }));

export function Shell() {
  const path = usePath();
  const route = routeFor(path);
  const inbox = useInboxCount();
  const sidebar = useSidebar();
  const palette = useSearchPalette();
  useTokenCheck();

  useEffect(() => {
    document.title = route === undefined ? "Simlock" : `${route.label} · Simlock`;
  }, [route]);

  const entries = ROUTES.map((entry) => ({
    current: entry === route,
    ...(entry.group === undefined ? {} : { group: entry.group }),
    icon: entry.icon,
    label: entry.label,
    to: entry.path,
    ...(entry.path === "/inbox" && inbox !== undefined ? { alert: true, count: inbox } : {}),
  }));

  return (
    <AppFrame
      sidebar={
        <Sidebar
          entries={entries}
          collapsed={sidebar.collapsed}
          onToggle={sidebar.toggle}
          onSearch={palette.show}
          footer={(collapsed) => <SidebarFoot collapsed={collapsed} />}
        />
      }
    >
      {route === undefined ? <NotFoundScreen /> : <route.Screen />}
      {palette.open ? <SearchDialog hide={palette.hide} /> : null}
    </AppFrame>
  );
}

function SidebarFoot({ collapsed }: { readonly collapsed: boolean }) {
  const signedIn = useSignedIn();
  const signOut = useSignOut();
  return (
    <>
      <ConnectionStatus collapsed={collapsed} />
      {signedIn.name === undefined || collapsed ? null : (
        <p className="signed-in-as">Signed in as {signedIn.name}</p>
      )}
      {signedIn.canSignOut ? (
        <SignOutButton collapsed={collapsed} name={signedIn.name} onClick={signOut} />
      ) : null}
    </>
  );
}

// why: the connection's word is a live region so a screen reader hears it change; the data's age
// beside it ticks every second, so it stays outside the region.
function ConnectionStatus({ collapsed }: { readonly collapsed: boolean }) {
  const status = useConnectionStatus();
  return (
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
  );
}

function SignOutButton(props: {
  readonly collapsed: boolean;
  readonly name: string | undefined;
  readonly onClick: () => void;
}) {
  const { collapsed, name, onClick } = props;
  return (
    <Button
      variant="secondary"
      className="sign-out"
      onClick={onClick}
      aria-label="Sign out"
      title={collapsed && name !== undefined ? `Sign out (${name})` : "Sign out"}
    >
      <Icon name="signOut" />
      <span className="nav-label">Sign out</span>
    </Button>
  );
}

function SearchDialog({ hide }: { readonly hide: () => void }) {
  const session = useSearchSession(PAGES, hide);
  return (
    <CommandPalette
      groups={session.groups}
      typed={session.typed}
      empty={session.empty}
      onType={session.type}
      onChoose={session.choose}
      onClose={hide}
    />
  );
}
