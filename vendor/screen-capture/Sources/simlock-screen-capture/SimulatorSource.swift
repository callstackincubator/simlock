// simlock's own, MIT-licensed (see NOTICE.md): the simulator's framebuffer as a `ScreenSource`.
//
// `FrameCapture` is serve-sim's file; this is the thin shape the shared lifecycle needs from it —
// start by UDID, hand each copied picture over, and stop. The 200 ms idle floor that re-emits the
// last picture when nothing new is painted is FrameCapture's own, and it is load-bearing here: a
// still simulator sends nothing, and a stream that sends nothing looks dead from the outside.
//
// A foldable streams the panel that holds the picture (`Panels.swift`): the one SpringBoard last moved
// it to before the start, then each one it moves it to while the stream runs. FrameCapture's
// preferred size is what picks the panel; a panel mounted on its side is turned upright here, so the
// lifecycle sees an upright picture whose size changes when the panel does.
import CoreVideo
import Foundation
import SimlockCapture

final class SimulatorSource: ScreenSource {
    private let capture = FrameCapture()
    private let rotator = PanelRotator()
    private var watcher: PanelWatcher?
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
        let panels = FrameCapture.findSimDevice(udid: deviceID).map(Panels.read(for:)) ?? []
        if panels.count == 2 {
            try await followPanels(panels, udid: deviceID)
        }
        let rotator = self.rotator
        try await capture.start(deviceUDID: deviceID) { pixelBuffer, _ in
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            if let panel = panels.first(where: { $0.matches(width: width, height: height) }),
               let rotation = PanelRotator.rotation(undoing: panel.nativeRotation) {
                if let upright = rotator.rotate(pixelBuffer, by: rotation) { onFrame(upright) }
                return
            }
            onFrame(pixelBuffer)
        }
    }

    /// Starts on the cover, moves to the panel in use once this boot's history is read, then follows
    /// every move.
    ///
    /// why: the history is read in the background, because reading it takes 2-4 s and a stream that
    /// waits for it shows nothing for that long; a device folded open shows its cover's black for that
    /// long instead, then the picture.
    private func followPanels(_ panels: [Panel], udid: String) async throws {
        let capture = self.capture
        let choose: @Sendable (PanelRole) async -> Void = { role in
            guard let panel = Panels.panel(role, of: panels) else { return }
            log("[panels] streaming the \(role.rawValue) panel \(panel.name) (\(panel.width)x\(panel.height))")
            await capture.setPreferredScreenSize(width: panel.width, height: panel.height)
        }
        let heardLive = OneShot<Bool>()
        let watcher = PanelWatcher(udid: udid, deviceSet: FrameCapture.deviceSetPath) { role in
            heardLive.set(true)
            Task { await choose(role) }
        }
        self.watcher = watcher
        // why: the live log starts before this boot's history is read, so a fold during the read is
        // not missed, and a move heard live is newer than anything the history holds, so it wins.
        watcher.start()
        await choose(.cover)
        Thread.detachNewThread {
            let earlier = watcher.current()
            if let earlier, earlier != .cover, heardLive.offered() == nil { Task { await choose(earlier) } }
        }
    }

    func stop() async {
        // why: idempotent — the lifecycle calls it on every way out, and a second `stop` would
        // unregister callbacks this source no longer owns.
        guard !stopped else { return }
        stopped = true
        watcher?.stop()
        await capture.stop()
    }
}
