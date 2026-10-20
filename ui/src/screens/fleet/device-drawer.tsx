import "./fleet.css";

import { Drawer, Facts, Link, Loaded, Status } from "../../ds";
import { type DeviceRow, useDeviceDrawer, useLeaseUdid } from "../../state/workers";

// why: the drawer opens at once, titled "Device" until the worker's page arrives, and says so when
// the worker no longer lists the device, so an address that outlives its device still lands
// somewhere.
export function DeviceDrawer(props: { readonly workerId: string; readonly deviceId: string }) {
  const { deviceId, workerId } = props;
  const { close, view } = useDeviceDrawer(workerId, deviceId);
  const device = view.kind === "ready" ? view.data : undefined;
  return (
    <Drawer
      title={device === undefined ? "Device" : `${device.model} ${device.runtime}`}
      onClose={close}
      finalFocus={() => focusAfterClosing(workerId, deviceId)}
    >
      {view.kind === "ready" && device === undefined ? (
        <p className="muted device-drawer-body">This device is gone.</p>
      ) : (
        <Loaded view={view}>
          {(row) => (row === undefined ? null : <DeviceFacts device={row} />)}
        </Loaded>
      )}
    </Drawer>
  );
}

function DeviceFacts({ device }: { readonly device: DeviceRow }) {
  return device.lease === undefined ? (
    <FactList device={device} udid={device.udid} />
  ) : (
    <LeasedFactList device={device} leaseId={device.lease.id} />
  );
}

function LeasedFactList({
  device,
  leaseId,
}: {
  readonly device: DeviceRow;
  readonly leaseId: string;
}) {
  const udid = useLeaseUdid(leaseId);
  return <FactList device={device} udid={udid ?? device.udid} />;
}

function FactList({
  device,
  udid,
}: {
  readonly device: DeviceRow;
  readonly udid: string | undefined;
}) {
  return (
    <div className="device-drawer-body">
      <Facts
        facts={[
          { label: "Model", value: device.model },
          { label: "Runtime", value: <span className="mono">{device.runtime}</span> },
          {
            label: "State",
            value: <Status tone={device.status.tone}>{device.status.word}</Status>,
          },
          ...(device.holder === undefined ? [] : [{ label: "Holder", value: device.holder.name }]),
          ...(device.lease === undefined
            ? []
            : [
                {
                  label: "Lease",
                  value: (
                    <Link to={device.lease.to}>
                      <span className="mono">{device.lease.id}</span>
                    </Link>
                  ),
                },
              ]),
          ...(udid === undefined
            ? []
            : [{ label: "UDID", value: <span className="mono">{udid}</span> }]),
        ]}
      />
    </div>
  );
}

// why: focus goes back to the row that opened the drawer, or to the page's heading when that row is
// gone or the drawer was loaded directly.
function focusAfterClosing(workerId: string, deviceId: string): HTMLElement | null {
  const prefix = `/fleet/${encodeURIComponent(workerId)}/${encodeURIComponent(deviceId)}`;
  const row = [...document.querySelectorAll<HTMLElement>("main tbody a")].find((link) =>
    link.getAttribute("href")?.startsWith(prefix),
  );
  return row ?? document.querySelector<HTMLElement>("main h1");
}
