// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1534).
import Foundation
import SimlockCapture

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
    private let lock = NSLock()
    private var current: Panel?
    private var onPanel: (@Sendable (Panel) -> Void)?
    private var stopped = false
    private var heardLine = false
    private var heardMove = false

    init(panels: [Panel], sampler: PanelSampler, log: PanelLog, clock: PanelClock) {
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
            log("[panels] \(panels.count) panels; staying on the first")
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
            if !isSilenceBroken { log("[panels] no panel move heard; staying on \(currentRole)") }
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
