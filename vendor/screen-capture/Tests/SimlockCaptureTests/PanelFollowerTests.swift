import XCTest

@testable import simlock_screen_capture

final class FakeSampler: PanelSampler {
    let answer: [Int: Bool]
    init(_ answer: [Int: Bool]) { self.answer = answer }
    func lit(_ panels: [Panel]) async -> [Int: Bool] { answer }
}

final class FakeLog: PanelLog, @unchecked Sendable {
    private let lock = NSLock()
    private let boot: [String]
    private(set) var liveStarts = 0
    private var onLine: (@Sendable (String) -> Void)?
    private var onEnd: (@Sendable () -> Void)?

    init(boot: [String] = []) { self.boot = boot }

    func bootLines(timeout: TimeInterval) async -> [String] { boot }
    func live(onLine: @escaping @Sendable (String) -> Void, onEnd: @escaping @Sendable () -> Void) {
        lock.lock()
        liveStarts += 1
        self.onLine = onLine
        self.onEnd = onEnd
        lock.unlock()
    }
    func stop() {}
    func say(_ line: String) { lock.lock(); let handler = onLine; lock.unlock(); handler?(line) }
    func end() { lock.lock(); let handler = onEnd; lock.unlock(); handler?() }
}

final class FakeClock: PanelClock, @unchecked Sendable {
    func sleep(seconds: TimeInterval) async {}
}

final class Picks: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    func add(_ panel: Panel) { lock.lock(); names.append(panel.name); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return names }
}

/// Lets the follower's background tasks run; a count of turns, never a time.
func settle() async { for _ in 0..<200 { await Task.yield() } }

func move(_ role: PanelRole) -> String {
    let other = role == .cover ? "inner" : "cover"
    return "2026-11-11 10:00:00.1 Df SpringBoard[88:1f] [com.apple.SpringBoard:DisplayContentMode] swapped  .\(role.rawValue):pri .\(other):aux"
}

let cover = Panel(name: "cover", screenID: 1, width: 1398, height: 2034, nativeRotation: 0, role: .cover)
let inner = Panel(name: "inner", screenID: 3, width: 2007, height: 2853, nativeRotation: 270, role: .inner)

final class PanelFollowerStartTests: XCTestCase {
    func testTheFollowerPicksThePanelAtStart() async {
        let third = Panel(name: "third", screenID: 5, width: 100, height: 100, nativeRotation: 0, role: nil)
        let lone = Panel(name: "lone", screenID: 1, width: 100, height: 200, nativeRotation: 0, role: nil)
        let cases: [(title: String, panels: [Panel], lit: [Int: Bool], boot: [String], picks: [String], liveStarts: Int)] = [
            ("one panel: not started", [lone], [1: true], [], [], 0),
            ("cover lit", [cover, inner], [1: true, 3: false], [move(.inner)], ["cover"], 1),
            ("inner lit", [cover, inner], [1: false, 3: true], [move(.cover)], ["inner"], 1),
            ("both dark, boot says inner", [cover, inner], [1: false, 3: false], [move(.cover), move(.inner)], ["cover", "inner"], 1),
            ("both lit, boot says inner", [cover, inner], [1: true, 3: true], [move(.inner)], ["cover", "inner"], 1),
            ("both dark, boot says cover", [cover, inner], [1: false, 3: false], [move(.inner), move(.cover)], ["cover"], 1),
            ("both dark, boot log unread", [cover, inner], [1: false, 3: false], [], ["cover"], 1),
            ("more than two panels: the first", [inner, cover, third], [1: true, 3: true, 5: true], [], ["inner"], 0),
        ]
        for row in cases {
            let log = FakeLog(boot: row.boot)
            let follower = PanelFollower(panels: row.panels, sampler: FakeSampler(row.lit), log: log, clock: FakeClock())
            let picks = Picks()
            await follower.start { picks.add($0) }
            XCTAssertEqual(picks.all.count, row.picks.isEmpty ? 0 : 1, "\(row.title): the first panel is not reported before start returns")
            await settle()
            XCTAssertEqual(picks.all, row.picks, row.title)
            XCTAssertEqual(log.liveStarts, row.liveStarts, row.title)
            follower.stop()
        }
    }
}
