import { ScreenView } from "../screen-view";
import { type StreamOffer, useDeviceScreen } from "../../state/screen";

// why: the hook lives in the panel's own component so that leaving the tab, closing the drawer and
// leaving the device all end the same capture, and a panel that is not drawn never starts one.
export function ScreenPanel(props: {
  readonly workerId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly offer: StreamOffer;
}) {
  const { deviceId, offer, state, workerId } = props;
  const shown = useDeviceScreen(workerId, deviceId, state, offer);
  return shown.kind === "picture" ? (
    <ScreenView screen={shown.screen} />
  ) : (
    <p className="muted device-drawer-body">{shown.text}</p>
  );
}
