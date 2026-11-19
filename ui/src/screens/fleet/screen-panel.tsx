import { type StreamOffer, useDeviceScreen } from "../../state/screen";
import { ScreenNotice, ScreenView } from "../screen-view";

// why: the hook lives in the panel's own component so that leaving the page ends the capture, and a
// panel that is not drawn never starts one.
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
    <ScreenNotice text={shown.text} />
  );
}
