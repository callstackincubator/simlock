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
    private let rotator = PanelRotator()
    private var follower: PanelFollower?
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
        SimFrameworks.load()
        let panels = FrameCapture.findSimDevice(udid: deviceID).map { Panels.read(for: $0, udid: deviceID) } ?? []
        if panels.count > 1 { try await follow(panels, udid: deviceID) }
        let rotator = self.rotator
        try await capture.start(deviceUDID: deviceID) { pixelBuffer, _ in
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            // why: by size, not by the panel in use, because a picture of the panel just left can still
            // be on its way after a switch, and it must be turned the way its own panel is mounted.
            if let panel = panels.first(where: { $0.matches(width: width, height: height) }),
               let rotation = PanelRotator.rotation(undoing: panel.nativeRotation) {
                if let upright = rotator.rotate(pixelBuffer, by: rotation) { onFrame(upright) }
                return
            }
            onFrame(pixelBuffer)
        }
    }

    /// Streams the panel in use: the one picked now, then each one SpringBoard moves the picture to.
    private func follow(_ panels: [Panel], udid: String) async throws {
        let capture = self.capture
        let follower = PanelFollower(
            panels: panels, sampler: SimctlPanelSampler(udid: udid), log: SimctlPanelLog(udid: udid),
            clock: SystemPanelClock()
        )
        self.follower = follower
        let first = Box<Panel?>(nil)
        await follower.start { panel in
            first.setIfEmpty(panel)
            log("[panels] streaming the \(panel.name) panel (\(panel.width)x\(panel.height))")
            Task { await capture.setPreferredScreenSize(width: panel.width, height: panel.height) }
        }
        // why: the first panel is set before the capture starts, not through the task above, so the
        // capture opens on it and not on the smallest surface for a moment.
        if let panel = first.value { await capture.setPreferredScreenSize(width: panel.width, height: panel.height) }
    }

    func stop() async {
        // why: idempotent — the lifecycle calls it on every way out, and a second `stop` would
        // unregister callbacks this source no longer owns.
        guard !stopped else { return }
        stopped = true
        follower?.stop()
        await capture.stop()
    }
}

/// A value set from a callback and read after it.
final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ initial: Value) { stored = initial }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
}

extension Box {
    func setIfEmpty<Wrapped>(_ new: Wrapped) where Value == Wrapped? {
        lock.lock()
        if stored == nil { stored = new }
        lock.unlock()
    }
}
