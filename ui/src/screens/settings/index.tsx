import "./settings.css";

import type { ReactNode } from "react";

import { Button, ChoiceChips, Facts, Loaded, Page, Panel } from "../../ds";
import {
  type ConfigSection,
  type DaemonSettings,
  HOLDER_CHOICES,
  ROWS_CHOICES,
  SETTINGS_RANGE_CHOICES,
  THEME_CHOICES,
  type ConsoleSettings,
  useConsoleSettings,
  useCopySetCommand,
  useDaemonSettings,
} from "../../state/settings";
import { useSidebar } from "../../state/sidebar";

const SIDEBAR_CHOICES = [
  { label: "Expanded", value: "expanded" },
  { label: "Collapsed", value: "collapsed" },
] as const;

export function SettingsScreen() {
  const console = useConsoleSettings(useSidebar());
  const daemon = useDaemonSettings();
  const copy = useCopySetCommand();
  return <SettingsBody console={console} daemon={daemon} copy={copy} />;
}

export function SettingsBody(props: {
  readonly console: ConsoleSettings;
  readonly daemon: DaemonSettings;
  readonly copy: (key: string, value: string) => void;
}) {
  return (
    <Page title="Settings">
      <div className="settings-stack">
        <ConsoleCard settings={props.console} />
        <DaemonCard daemon={props.daemon} copy={props.copy} />
      </div>
    </Page>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{props.label}</span>
      {props.children}
    </div>
  );
}

function ConsoleCard({ settings }: { readonly settings: ConsoleSettings }) {
  const { change } = settings;
  const values = settings.settings;
  return (
    <Panel title="Console">
      <p className="muted settings-note">Kept in this browser.</p>
      <Row label="Theme">
        <ChoiceChips
          legend="Theme"
          choices={THEME_CHOICES}
          value={values.theme}
          onChange={(theme) => change({ theme })}
        />
      </Row>
      <Row label="Sidebar">
        <ChoiceChips
          legend="Sidebar"
          choices={SIDEBAR_CHOICES}
          value={settings.sidebarCollapsed ? "collapsed" : "expanded"}
          onChange={(choice) => settings.setSidebarCollapsed(choice === "collapsed")}
        />
      </Row>
      <Row label="Default range">
        <ChoiceChips
          legend="Default range for Overview and Activity"
          choices={SETTINGS_RANGE_CHOICES}
          value={values.range}
          onChange={(range) => change({ range })}
        />
      </Row>
      <Row label="Rows per page">
        <ChoiceChips
          legend="Rows per page"
          choices={ROWS_CHOICES}
          value={`${values.rows}`}
          onChange={(rows) => change({ rows: Number(rows) as 25 | 50 | 100 })}
        />
      </Row>
      <Row label="Holder ids">
        <ChoiceChips
          legend="Holder ids"
          choices={HOLDER_CHOICES}
          value={values.holders}
          onChange={(holders) => change({ holders })}
        />
      </Row>
    </Panel>
  );
}

function DaemonCard(props: {
  readonly daemon: DaemonSettings;
  readonly copy: (key: string, value: string) => void;
}) {
  const { copy, daemon } = props;
  return (
    <Panel title="Daemon">
      <p className="muted settings-note">
        Change these with <code>simlock config set &lt;key&gt; &lt;value&gt;</code> on the
        daemon&apos;s machine.
      </p>
      {daemon.kind === "forbidden" ? (
        <p className="muted">Your token cannot read this daemon&apos;s settings.</p>
      ) : daemon.kind === "older" ? (
        <p className="muted">This daemon is too old to report its settings.</p>
      ) : (
        <Loaded view={daemon.view}>
          {(sections) =>
            sections.length === 0 ? (
              <p className="muted">The daemon reports no settings.</p>
            ) : (
              sections.map((section) => (
                <Section key={section.name} section={section} copy={copy} />
              ))
            )
          }
        </Loaded>
      )}
    </Panel>
  );
}

function Section(props: {
  readonly section: ConfigSection;
  readonly copy: (key: string, value: string) => void;
}) {
  const { copy, section } = props;
  return (
    <section className="settings-section" aria-label={section.name}>
      <h3 className="settings-section-title">{section.name}</h3>
      <Facts
        raw
        facts={section.entries.map((entry) => ({
          label: entry.key,
          value: (
            <span className="settings-value">
              <span className="settings-text">{entry.value}</span>
              {entry.masked ? null : (
                <Button
                  small
                  variant="quiet"
                  aria-label={`Copy the command to set ${entry.key}`}
                  onClick={() => copy(entry.key, entry.value)}
                >
                  Copy
                </Button>
              )}
            </span>
          ),
        }))}
      />
    </section>
  );
}
