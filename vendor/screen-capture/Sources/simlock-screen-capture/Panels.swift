// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1457).
//
// An iPhone Duo has two built-in panels, a 1398x2034 cover and a 2007x2853 inner panel, and both
// framebuffers stay live in every pose: the panel not in use is painted black. The simulator raises no
// callback on a fold (no surfaces- or properties-changed call arrives, and the host-side backlight
// state never changes), so the pose is read from SpringBoard, the process that moves the picture
// between panels. Its `DisplayContentMode` log names the panel that holds the picture as `pri`, once a
// transition swaps (`transitioning  .inner:pri .cover:aux`) and again when it completes.
//
// A device with one panel never starts any of this.
import CoreVideo
import Foundation
import SimlockCapture
import VideoToolbox

/// One built-in touch panel, as the device type's `capabilities.plist` describes it.
struct Panel: Equatable {
    let name: String
    let width: Int
    let height: Int
    /// Degrees the panel is mounted at relative to its framebuffer; the inner Duo panel's is 270, so
    /// its framebuffer holds the picture on its side.
    let nativeRotation: Int

    func matches(width: Int, height: Int) -> Bool {
        (self.width == width && self.height == height) || (self.width == height && self.height == width)
    }
}

enum PanelRole: String {
    case cover, inner
}

enum Panels {
    /// The device type's built-in touch panels, the same filter `DeviceDisplaySizes` applies.
    static func read(for device: NSObject) -> [Panel] {
        guard
            let deviceType = device.perform(NSSelectorFromString("deviceType"))?.takeUnretainedValue() as? NSObject,
            let bundle = deviceType.value(forKey: "bundlePath") as? String,
            let data = try? Data(contentsOf: URL(fileURLWithPath: bundle).appendingPathComponent("Contents/Resources/capabilities.plist")),
            let root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return [] }
        let capabilities = root["capabilities"] as? [String: Any] ?? root
        let displays = capabilities["displays"] as? [[String: Any]] ?? []
        return displays.compactMap { display in
            guard display["displayType"] as? String == "integrated",
                  (display["hasDigitizer"] as? NSNumber)?.boolValue == true,
                  !((display["chromeIdentifier"] as? String) ?? "").isEmpty,
                  let width = (display["width"] as? NSNumber)?.intValue,
                  let height = (display["height"] as? NSNumber)?.intValue
            else { return nil }
            return Panel(
                name: display["deviceName"] as? String ?? "?",
                width: width,
                height: height,
                nativeRotation: (display["nativeRotation"] as? NSNumber)?.intValue ?? 0
            )
        }
    }

    /// The panel SpringBoard calls `role`: of two panels the smaller is the cover.
    static func panel(_ role: PanelRole, of panels: [Panel]) -> Panel? {
        guard panels.count == 2 else { return nil }
        let sorted = panels.sorted { $0.width * $0.height < $1.width * $1.height }
        return role == .cover ? sorted[0] : sorted[1]
    }

    /// The panel holding the picture, from one SpringBoard `DisplayContentMode` line, or nil when the
    /// line names none.
    ///
    /// why: only a settled line counts. A line whose roles carry an arrow (`.inner:off→pri`) is a
    /// transition that has just started and may still turn back; the swap line after it has none.
    ///
    /// why: the line must carry SpringBoard's own category tag. `log` opens its output with a header
    /// that repeats the filter, `.cover:pri` and `.inner:pri` both, and that header is no move.
    static func primary(inLogLine line: String) -> PanelRole? {
        guard line.contains("[com.apple.SpringBoard:DisplayContentMode]") else { return nil }
        let pattern = try! NSRegularExpression(pattern: #"\.(inner|cover):([a-z]+)(→)?"#)
        let range = NSRange(line.startIndex..., in: line)
        var primaries: [PanelRole] = []
        for match in pattern.matches(in: line, range: range) {
            if match.range(at: 3).location != NSNotFound { return nil }
            guard let role = Range(match.range(at: 1), in: line), let state = Range(match.range(at: 2), in: line) else { continue }
            if line[state] == "pri", let named = PanelRole(rawValue: String(line[role])) { primaries.append(named) }
        }
        return primaries.count == 1 ? primaries[0] : nil
    }
}

/// Follows SpringBoard's panel moves for one simulator, by `log stream` inside it.
final class PanelWatcher: @unchecked Sendable {
    static let predicate =
        #"process == "SpringBoard" AND category == "DisplayContentMode" AND (eventMessage CONTAINS ".cover:pri" OR eventMessage CONTAINS ".inner:pri")"#

    private let udid: String
    private let deviceSet: String?
    private let onPrimary: @Sendable (PanelRole) -> Void
    private let lock = NSLock()
    private var process: Process?
    private var stopped = false
    private var pending = ""

    init(udid: String, deviceSet: String?, onPrimary: @escaping @Sendable (PanelRole) -> Void) {
        self.udid = udid
        self.deviceSet = deviceSet
        self.onPrimary = onPrimary
    }

    private func simctl(_ arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl"] + (deviceSet.map { ["--set", $0] } ?? []) + ["spawn", udid] + arguments
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        return process
    }

    /// The panel holding the picture now, from this boot's last panel move (a boot logs one too, onto
    /// the cover); nil when the log could not be read in time.
    func current(timeout: TimeInterval = 10) -> PanelRole? {
        let process = simctl(["log", "show", "--last", "boot", "--style", "compact", "--predicate", Self.predicate])
        let output = Pipe()
        process.standardOutput = output
        guard (try? process.run()) != nil else { return nil }
        let deadline = DispatchWorkItem { process.terminate() }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        deadline.cancel()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        return lines.reversed().lazy.compactMap { Panels.primary(inLogLine: String($0)) }.first
    }

    /// Starts following, and starts again a second later when the log stream ends while still wanted.
    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, process == nil else { return }
        let process = simctl(["log", "stream", "--style", "compact", "--predicate", Self.predicate])
        let output = Pipe()
        process.standardOutput = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard let self, !chunk.isEmpty else { return }
            self.consume(String(decoding: chunk, as: UTF8.self))
        }
        process.terminationHandler = { [weak self] _ in
            output.fileHandleForReading.readabilityHandler = nil
            guard let self else { return }
            self.lock.lock()
            self.process = nil
            let again = !self.stopped
            self.lock.unlock()
            if again { DispatchQueue.global().asyncAfter(deadline: .now() + 1) { self.start() } }
        }
        do {
            try process.run()
            self.process = process
        } catch {
            log("[panels] could not follow SpringBoard: \(error)")
        }
    }

    private func consume(_ text: String) {
        lock.lock()
        pending += text
        var lines = pending.components(separatedBy: "\n")
        pending = String(lines.removeLast().suffix(4096))
        lock.unlock()
        for line in lines {
            if let role = Panels.primary(inLogLine: line) { onPrimary(role) }
        }
    }

    func stop() {
        lock.lock()
        stopped = true
        let process = self.process
        lock.unlock()
        process?.terminate()
    }
}

/// Turns a panel mounted on its side upright, on the GPU.
///
/// Not thread-safe by itself: the capture calls it from its one callback queue.
final class PanelRotator {
    private var session: VTPixelRotationSession?
    private var pool: CVPixelBufferPool?
    private var poolSize = (width: 0, height: 0)
    private var rotation: CFString?

    /// The VideoToolbox rotation that undoes a panel's mounting, or nil for an upright panel.
    static func rotation(undoing nativeRotation: Int) -> CFString? {
        switch (nativeRotation % 360 + 360) % 360 {
        case 90: return kVTRotation_CCW90
        case 180: return kVTRotation_180
        case 270: return kVTRotation_CW90
        default: return nil
        }
    }

    func rotate(_ source: CVPixelBuffer, by rotation: CFString) -> CVPixelBuffer? {
        if session == nil {
            var created: VTPixelRotationSession?
            guard VTPixelRotationSessionCreate(kCFAllocatorDefault, &created) == noErr
            else { return nil }
            session = created
        }
        guard let session else { return nil }
        if self.rotation != rotation {
            VTSessionSetProperty(session, key: kVTPixelRotationPropertyKey_Rotation, value: rotation)
            self.rotation = rotation
        }
        let quarterTurn = rotation != kVTRotation_180
        let width = quarterTurn ? CVPixelBufferGetHeight(source) : CVPixelBufferGetWidth(source)
        let height = quarterTurn ? CVPixelBufferGetWidth(source) : CVPixelBufferGetHeight(source)
        if pool == nil || poolSize != (width, height) {
            let attributes: [String: Any] = [
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
            poolSize = (width, height)
        }
        guard let pool else { return nil }
        var target: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &target) == noErr, let target,
              VTPixelRotationSessionRotateImage(session, source, target) == noErr
        else { return nil }
        return target
    }
}
