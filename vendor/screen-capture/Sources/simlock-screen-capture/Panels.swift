// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1534).
import CoreVideo
import Foundation
import ImageIO
import SimlockCapture
import VideoToolbox

enum PanelRole: String {
    case cover, inner
}

enum Panels {
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

/// One built-in touch panel of a simulator.
struct Panel: Equatable {
    let name: String
    /// The id `simctl io enumerate` lists the panel under; also its touch target.
    let screenID: Int
    let width: Int
    let height: Int
    /// Degrees the panel is mounted at relative to its framebuffer; the inner Duo panel's is 270, so
    /// its framebuffer holds the picture on its side.
    let nativeRotation: Int
    /// Set only on a device with exactly two panels, where the smaller is the cover.
    let role: PanelRole?
}

/// Which of a device's panels are lit right now.
protocol PanelSampler: Sendable {
    /// A panel that failed or was late to read is dark.
    func lit(_ panels: [Panel]) async -> [Int: Bool]
}

/// SpringBoard's panel moves, as log lines.
protocol PanelLog: AnyObject, Sendable {
    /// This boot's moves, oldest first; empty when they could not be read within `timeout`.
    func bootLines(timeout: TimeInterval) async -> [String]
    /// Streams lines as they come; `onEnd` runs when the stream ends by itself.
    func live(onLine: @escaping @Sendable (String) -> Void, onEnd: @escaping @Sendable () -> Void)
    func stop()
}

protocol PanelClock: Sendable {
    func sleep(seconds: TimeInterval) async
}

/// Picks the panel in use when it starts, then reports each move SpringBoard makes.
final class PanelFollower: @unchecked Sendable {
    /// How long a start waits for this boot's log when the lit panel does not say which is in use.
    static let bootReadSeconds: TimeInterval = 10
    /// How long without a line before the follower says it hears nothing.
    static let silenceSeconds: TimeInterval = 30

    private let panels: [Panel]
    private let sampler: PanelSampler
    private let source: PanelLog
    private let clock: PanelClock
    private let note: @Sendable (String) -> Void
    private let lock = NSLock()
    private var current: Panel?
    private var onPanel: (@Sendable (Panel) -> Void)?
    private var stopped = false
    private var heardLine = false
    private var heardMove = false

    static let toStderr: @Sendable (String) -> Void = { message in log(message) }

    init(
        panels: [Panel], sampler: PanelSampler, log: PanelLog, clock: PanelClock,
        note: @escaping @Sendable (String) -> Void = PanelFollower.toStderr
    ) {
        self.note = note
        self.panels = panels
        self.sampler = sampler
        self.source = log
        self.clock = clock
    }

    /// Reports the first panel before it returns, then each change.
    func start(onPanel: @escaping @Sendable (Panel) -> Void) async {
        guard panels.count >= 2 else { return }
        self.onPanel = onPanel
        guard panels.count == 2,
              let cover = panels.first(where: { $0.role == .cover }),
              let inner = panels.first(where: { $0.role == .inner })
        else {
            note("[panels] \(panels.count) panels; staying on the first")
            report(panels[0])
            return
        }
        // why: the live log starts before the lit panel is read, so a fold during the read is not
        // missed, and a move heard live is newer than anything read after it, so it wins.
        startLive()
        let lit = await sampler.lit(panels)
        let coverLit = lit[cover.screenID] ?? false
        let innerLit = lit[inner.screenID] ?? false
        if !hasReported { report(innerLit && !coverLit ? inner : cover) }
        Task {
            await clock.sleep(seconds: Self.silenceSeconds)
            if !isSilenceBroken { note("[panels] no panel move heard; staying on \(currentRole)") }
        }
        if coverLit == innerLit {
            // why: a black app lights neither panel and a bright one lights both, so the lit panel
            // does not say which one SpringBoard shows; this boot's last move does.
            Task {
                let lines = await source.bootLines(timeout: Self.bootReadSeconds)
                if !heardMove, let role = lines.reversed().lazy.compactMap({ Panels.primary(inLogLine: $0) }).first,
                   let panel = panels.first(where: { $0.role == role }) {
                    report(panel)
                }
            }
        }
    }

    private var hasReported: Bool { lock.lock(); defer { lock.unlock() }; return current != nil }
    private var isSilenceBroken: Bool { lock.lock(); defer { lock.unlock() }; return heardLine || stopped }
    private var currentRole: String { lock.lock(); defer { lock.unlock() }; return current?.role?.rawValue ?? "?" }

    private func startLive() {
        source.live(
            onLine: { [weak self] line in self?.heard(line) },
            onEnd: { [weak self] in self?.liveEnded() }
        )
    }

    private func heard(_ line: String) {
        guard let role = Panels.primary(inLogLine: line) else { return }
        lock.lock()
        heardLine = true
        heardMove = true
        lock.unlock()
        if let panel = panels.first(where: { $0.role == role }) { report(panel) }
    }

    private func liveEnded() {
        Task {
            await clock.sleep(seconds: 1)
            if !lock.withLock({ stopped }) { startLive() }
        }
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
        source.stop()
    }

    /// Hands the panel on unless it is the one already reported.
    private func report(_ panel: Panel) {
        lock.lock()
        let changed = current != panel && !stopped
        if changed { current = panel }
        lock.unlock()
        if changed { onPanel?(panel) }
    }
}

/// Runs a command so that it ends when the process holding the other end of its stdin pipe ends, by
/// any way, SIGKILL included.
enum Watchdog {
    // why: the command runs in the background with stdin off, and a second background job holds the
    // pipe on fd 3; `cat` returns when every writer is gone, which is the moment the holder ended,
    // and the command is killed then. `-9` because `simctl spawn … log` is only reliably ended by it.
    // The reader is killed once the command ends first, so neither outlives the other.
    private static let script = """
        exec 3<&0
        "$@" 3<&- </dev/null &
        child=$!
        { cat <&3 >/dev/null; kill -9 "$child" 2>/dev/null; } &
        reader=$!
        wait "$child"
        status=$?
        pkill -P "$reader" 2>/dev/null
        kill "$reader" 2>/dev/null
        exit "$status"
        """

    /// Not started; the caller keeps the `standardInput` pipe open for as long as the command should run.
    static func process(running command: [String]) -> Process {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, "sh"] + command
        process.standardInput = Pipe()
        return process
    }
}

// MARK: - The device

extension Panels {
    /// SpringBoard's panel moves, narrowed to the lines that name the panel in use.
    static let logPredicate =
        #"process == "SpringBoard" AND category == "DisplayContentMode" AND (eventMessage CONTAINS ".cover:pri" OR eventMessage CONTAINS ".inner:pri")"#

    /// `xcrun simctl [--set <set>] <arguments>`, the form every child of this file takes.
    static func simctl(_ arguments: [String]) -> [String] {
        ["/usr/bin/xcrun", "simctl"] + (FrameCapture.deviceSetPath.map { ["--set", $0] } ?? []) + arguments
    }

    /// The device type's built-in touch panels, from its `capabilities.plist` and the ids `simctl io
    /// enumerate` lists them under. Of two panels the smaller is the cover.
    static func read(for device: NSObject, udid: String) -> [Panel] {
        guard
            let deviceType = device.perform(NSSelectorFromString("deviceType"))?.takeUnretainedValue() as? NSObject,
            let bundle = deviceType.value(forKey: "bundlePath") as? String,
            let data = try? Data(contentsOf: URL(fileURLWithPath: bundle).appendingPathComponent("Contents/Resources/capabilities.plist")),
            let root = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return [] }
        let capabilities = root["capabilities"] as? [String: Any] ?? root
        let displays = capabilities["displays"] as? [[String: Any]] ?? []
        let builtIn = displays.filter { display in
            display["displayType"] as? String == "integrated"
                && (display["hasDigitizer"] as? NSNumber)?.boolValue == true
                && !((display["chromeIdentifier"] as? String) ?? "").isEmpty
        }
        guard builtIn.count > 1 else { return [] }
        let ids = screenIDs(inEnumerate: run(simctl(["io", udid, "enumerate"]), seconds: 3))
        var panels: [Panel] = builtIn.compactMap { display in
            guard let name = display["deviceName"] as? String, let screenID = ids[name],
                  let width = (display["width"] as? NSNumber)?.intValue,
                  let height = (display["height"] as? NSNumber)?.intValue
            else { return nil }
            return Panel(
                name: name, screenID: screenID, width: width, height: height,
                nativeRotation: (display["nativeRotation"] as? NSNumber)?.intValue ?? 0, role: nil
            )
        }
        if panels.count == 2 {
            panels.sort { $0.width * $0.height < $1.width * $1.height }
            panels = [panels[0].with(role: .cover), panels[1].with(role: .inner)]
        }
        return panels
    }

    /// Each screen's `Device Name` and `Screen ID` from `simctl io enumerate`.
    static func screenIDs(inEnumerate text: String) -> [String: Int] {
        var ids: [String: Int] = [:]
        var screenID: Int?
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Screen ID:") {
                screenID = Int(trimmed.dropFirst("Screen ID:".count).trimmingCharacters(in: .whitespaces))
            } else if trimmed.hasPrefix("Device Name:"), let screenID {
                ids[trimmed.dropFirst("Device Name:".count).trimmingCharacters(in: .whitespaces)] = screenID
            }
        }
        return ids
    }

    /// Runs a short command and returns what it printed, or nothing when it fails or outlives `seconds`.
    static func run(_ command: [String], seconds: TimeInterval) -> String {
        String(decoding: runData(command, seconds: seconds) ?? Data(), as: UTF8.self)
    }

    static func runData(_ command: [String], seconds: TimeInterval) -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command[0])
        process.arguments = Array(command.dropFirst())
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let cut = DispatchWorkItem { process.terminate() }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: cut)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        cut.cancel()
        return process.terminationStatus == 0 ? data : nil
    }
}

extension Panel {
    func with(role: PanelRole) -> Panel {
        Panel(name: name, screenID: screenID, width: width, height: height, nativeRotation: nativeRotation, role: role)
    }

    /// Whether a framebuffer of this size is this panel's, whichever way it is turned.
    func matches(width: Int, height: Int) -> Bool {
        (self.width == width && self.height == height) || (self.width == height && self.height == width)
    }
}

/// Reads whether each panel shows a picture, from `simctl io screenshot` of it.
struct SimctlPanelSampler: PanelSampler {
    let udid: String
    /// Mean luminance above which a panel counts as lit.
    static let litAbove = 0.02
    static let cutSeconds: TimeInterval = 3

    func lit(_ panels: [Panel]) async -> [Int: Bool] {
        await withTaskGroup(of: (Int, Bool).self) { group in
            for panel in panels {
                group.addTask { [udid] in
                    // why: a file, not `-`: simctl takes `-` as the name of a file in the working directory
                    // and writes nothing to stdout.
                    let file = NSTemporaryDirectory() + "simlock-panel-\(UUID().uuidString).png"
                    defer { try? FileManager.default.removeItem(atPath: file) }
                    let command = Panels.simctl(["io", udid, "screenshot", "--type=png", "--display=\(panel.screenID)", file])
                    guard Panels.runData(command, seconds: Self.cutSeconds) != nil,
                          let png = FileManager.default.contents(atPath: file)
                    else { return (panel.screenID, false) }
                    return (panel.screenID, Self.meanLuminance(ofPNG: png) > Self.litAbove)
                }
            }
            var answer: [Int: Bool] = [:]
            for await (id, isLit) in group { answer[id] = isLit }
            return answer
        }
    }

    /// 0 for black to 1 for white, over a 32x32 reduction of the picture.
    static func meanLuminance(ofPNG data: Data) -> Double {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return 0 }
        let side = 32
        var pixels = [UInt8](repeating: 0, count: side * side)
        let drew = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drew else { return 0 }
        return Double(pixels.reduce(0) { $0 + Int($1) }) / Double(pixels.count * 255)
    }
}

/// SpringBoard's log, read by `simctl spawn … log` children under a `Watchdog`.
final class SimctlPanelLog: PanelLog, @unchecked Sendable {
    private let udid: String
    private let lock = NSLock()
    private var children: [Process] = []
    private var stopped = false

    init(udid: String) { self.udid = udid }

    private func logCommand(_ verb: [String]) -> [String] {
        Panels.simctl(["spawn", udid, "log"] + verb + ["--style", "compact", "--predicate", Panels.logPredicate])
    }

    private func launch(_ verb: [String], stdout: Pipe) -> Process? {
        let process = Watchdog.process(running: logCommand(verb))
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        lock.lock()
        defer { lock.unlock() }
        guard !stopped, (try? process.run()) != nil else { return nil }
        children.append(process)
        return process
    }

    private func release(_ process: Process) {
        // why: closing the pipe is what ends the child; the watchdog kills it when no writer is left.
        try? (process.standardInput as? Pipe)?.fileHandleForWriting.close()
        lock.lock()
        children.removeAll { $0 === process }
        lock.unlock()
    }

    func bootLines(timeout: TimeInterval) async -> [String] {
        let output = Pipe()
        guard let process = launch(["show", "--last", "boot"], stdout: output) else { return [] }
        let cut = DispatchWorkItem { [weak self] in self?.release(process) }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: cut)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        cut.cancel()
        release(process)
        return String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }

    func live(onLine: @escaping @Sendable (String) -> Void, onEnd: @escaping @Sendable () -> Void) {
        let output = Pipe()
        guard let process = launch(["stream"], stdout: output) else {
            onEnd()
            return
        }
        let pending = LineBuffer(onLine)
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            pending.add(String(decoding: chunk, as: UTF8.self))
        }
        process.terminationHandler = { [weak self] ended in
            output.fileHandleForReading.readabilityHandler = nil
            self?.release(ended)
            onEnd()
        }
    }

    func stop() {
        lock.lock()
        stopped = true
        let open = children
        lock.unlock()
        for process in open { release(process) }
    }
}

/// Cuts a stream of text into lines.
final class LineBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    private let onLine: @Sendable (String) -> Void

    init(_ onLine: @escaping @Sendable (String) -> Void) { self.onLine = onLine }

    func add(_ chunk: String) {
        lock.lock()
        text += chunk
        var lines = text.components(separatedBy: "\n")
        text = String(lines.removeLast().suffix(4096))
        lock.unlock()
        for line in lines { onLine(line) }
    }
}

struct SystemPanelClock: PanelClock {
    func sleep(seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
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
            guard VTPixelRotationSessionCreate(kCFAllocatorDefault, &created) == noErr else { return nil }
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
