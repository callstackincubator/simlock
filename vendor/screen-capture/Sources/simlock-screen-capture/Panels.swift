// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1534).
import Foundation

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
    init(panels: [Panel], sampler: PanelSampler, log: PanelLog, clock: PanelClock) {}

    /// Reports the first panel before it returns, then each change.
    func start(onPanel: @escaping @Sendable (Panel) -> Void) async {}

    func stop() {}
}
