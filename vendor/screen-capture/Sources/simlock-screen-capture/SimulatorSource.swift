// simlock's own, MIT-licensed (see NOTICE.md): the simulator's framebuffer as a `ScreenSource`.
//
// `FrameCapture` is serve-sim's file; this is the thin shape the shared lifecycle needs from it —
// start by UDID, hand each copied picture over, and stop. The 200 ms idle floor that re-emits the
// last picture when nothing new is painted is FrameCapture's own, and it is load-bearing here: a
// still simulator sends nothing, and a stream that sends nothing looks dead from the outside.
import CoreVideo
import Foundation
import SimlockCapture

final class SimulatorSource: ScreenSource {
    private let capture = FrameCapture()
    private var stopped = false

    func start(
        deviceID: String,
        onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
        onEnd: @escaping @Sendable (_ reason: String?) -> Void
    ) async throws {
        // The simulator source has no way to notice its own end: a simulator that shuts down stops
        // calling back, and FrameCapture reports nothing else. The daemon notices the dead simulator
        // through the device's own state and closes the capture, so `onEnd` stays unused here.
        _ = onEnd
        try await capture.start(deviceUDID: deviceID) { pixelBuffer, _ in
            onFrame(pixelBuffer)
        }
    }

    func stop() async {
        // why: idempotent — the lifecycle calls it on every way out, and a second `stop` would
        // unregister callbacks this source no longer owns.
        guard !stopped else { return }
        stopped = true
        await capture.stop()
    }
}
