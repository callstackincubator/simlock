import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Banner, FeedRow, GroupHeader, LogRow, Pill, Ring } from "./index";

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
