import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Banner, FeedRow, GroupHeader, LogRow, Page, Pill, Ring } from "./index";

it("shows supplied labels, values and unavailable states in shared visual primitives", () => {
  const status = renderToStaticMarkup(<Pill tone="warn">drained</Pill>);
  expect(status).toContain("drained");
  expect(status).toContain("pill-warn");
  expect(status).toContain("pill-dot");
  const plain = renderToStaticMarkup(
    <Pill tone="idle" plain>
      now 19
    </Pill>,
  );
  expect(plain).toContain("now 19");
  expect(plain).not.toContain("pill-dot");

  for (const [percent, value] of [
    [0, "0%"],
    [42, "42%"],
    [undefined, "—"],
  ] as const) {
    const ring = renderToStaticMarkup(
      <Ring label="CPU" {...(percent === undefined ? {} : { percent })} />,
    );
    expect(ring).toContain("CPU");
    expect(ring).toContain(value);
  }

  const log = renderToStaticMarkup(
    <LogRow
      time="18:20"
      status={<b>failed</b>}
      event="device.failed"
      subject="phone"
      detail="offline"
      tone="error"
    />,
  );
  for (const value of ["18:20", "<b>failed</b>", "device.failed", "phone", "offline"])
    expect(log).toContain(value);
  const feed = renderToStaticMarkup(
    <FeedRow
      icon={<b>!</b>}
      event="lease.granted"
      subject="phone"
      detail="held"
      worker="mac-01"
      time="18:21"
    />,
  );
  for (const value of ["<b>!</b>", "lease.granted", "phone", "held", "mac-01", "18:21"])
    expect(feed).toContain(value);
  const group = renderToStaticMarkup(<GroupHeader count={3}>Healthy</GroupHeader>);
  expect(group).toContain("Healthy");
  expect(group).toContain("3");
  const nodeGroup = renderToStaticMarkup(
    <GroupHeader count={<strong>4</strong>}>
      <em>Node group</em>
    </GroupHeader>,
  );
  expect(nodeGroup).toContain("<em>Node group</em>");
  expect(nodeGroup).toContain("<strong>4</strong>");
  const banner = renderToStaticMarkup(
    <Banner
      count={2}
      title="Needs you"
      detail="first issue"
      action={<a href="/inbox">Open Inbox</a>}
    />,
  );
  for (const value of ["2", "Needs you", "first issue", 'href="/inbox"', "Open Inbox"])
    expect(banner).toContain(value);
  const nodeBanner = renderToStaticMarkup(
    <Banner
      count={1}
      title={<strong>Node title</strong>}
      detail={<em>Node detail</em>}
      action={null}
    />,
  );
  expect(nodeBanner).toContain("<strong>Node title</strong>");
  expect(nodeBanner).toContain("<em>Node detail</em>");
});

it("a log row and a feed row carry each cut part's whole text in a title, the text inside a link included", () => {
  const log = renderToStaticMarkup(
    <LogRow
      time="18:20"
      status={null}
      event={<a href="/fleet/w">worker.drained</a>}
      subject="mac-studio-with-a-very-long-hostname"
      detail={["iPhone 16", " · ", "agent-7"]}
    />,
  );
  const feed = renderToStaticMarkup(
    <FeedRow
      icon={null}
      event={<a href="/leases/l">lease.granted</a>}
      subject="agent-with-a-long-id"
      detail={<span className="muted">· iPhone 16</span>}
      worker="mac-1"
      time="18:20"
    />,
  );

  expect(log).toContain('title="worker.drained"');
  expect(log).toContain('title="mac-studio-with-a-very-long-hostname"');
  expect(log).toContain('title="iPhone 16 · agent-7"');
  expect(feed).toContain('title="lease.granted agent-with-a-long-id · iPhone 16 mac-1"');
});

it("a page title, cut on one line, carries its whole text with its parent in a title", () => {
  const page = renderToStaticMarkup(
    <Page title="mac-studio-with-a-very-long-hostname" crumb={{ label: "Fleet", to: "/fleet" }}>
      {null}
    </Page>,
  );

  expect(page).toContain('title="Fleet / mac-studio-with-a-very-long-hostname"');
});
