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

    private var bootGate: CheckedContinuation<Void, Never>?
    private let holdsBoot: Bool

    init(boot: [String] = [], holdsBoot: Bool = false) {
        self.boot = boot
        self.holdsBoot = holdsBoot
    }

    func bootLines(timeout: TimeInterval) async -> [String] {
        if holdsBoot {
            await withCheckedContinuation { gate in
                lock.lock()
                bootGate = gate
                lock.unlock()
            }
        }
        return boot
    }

    func releaseBoot() { lock.lock(); let gate = bootGate; bootGate = nil; lock.unlock(); gate?.resume() }
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

/// A clock that moves only when a test says so.
final class FakeClock: PanelClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: TimeInterval = 0
    private var waiting: [(deadline: TimeInterval, wake: CheckedContinuation<Void, Never>)] = []

    func sleep(seconds: TimeInterval) async {
        await withCheckedContinuation { wake in
            lock.lock()
            waiting.append((now + seconds, wake))
            lock.unlock()
        }
    }

    func advance(_ seconds: TimeInterval) {
        lock.lock()
        now += seconds
        let due = waiting.filter { $0.deadline <= now }
        waiting.removeAll { $0.deadline <= now }
        lock.unlock()
        for sleeper in due { sleeper.wake.resume() }
    }
}

final class Picks: @unchecked Sendable {
    private let lock = NSLock()
    private var names: [String] = []
    func add(_ panel: Panel) { lock.lock(); names.append(panel.name); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return names }
}

/// Lets the follower's background tasks run on the other threads of the pool; patience, never a bound
/// a test asserts.
func settle() async { for _ in 0..<50 { try? await Task.sleep(nanoseconds: 2_000_000) } }

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

final class PanelFollowerLiveTests: XCTestCase {
    private func started(
        lit: [Int: Bool] = [1: true, 3: false], log: FakeLog = FakeLog()
    ) async -> (follower: PanelFollower, log: FakeLog, clock: FakeClock, picks: Picks) {
        let clock = FakeClock()
        let picks = Picks()
        let follower = PanelFollower(panels: [cover, inner], sampler: FakeSampler(lit), log: log, clock: clock)
        await follower.start { picks.add($0) }
        return (follower, log, clock, picks)
    }

    func testTheFollowerFollowsLiveMoves() async {
        // a live move is reported once, and the same panel again is not
        let run = await started()
        run.log.say(move(.inner))
        await settle()
        run.log.say(move(.inner))
        await settle()
        XCTAssertEqual(run.picks.all, ["cover", "inner"], "a live move, then the same panel again")
        run.log.say(move(.cover))
        await settle()
        XCTAssertEqual(run.picks.all, ["cover", "inner", "cover"], "a move back")
        run.follower.stop()

        // a live move heard while the boot log is still read wins over what the boot log says
        let slow = await started(lit: [1: false, 3: false], log: FakeLog(boot: [move(.cover)], holdsBoot: true))
        slow.log.say(move(.inner))
        await settle()
        slow.log.releaseBoot()
        await settle()
        XCTAssertEqual(slow.picks.all, ["cover", "inner"], "the live move wins over the boot log")
        slow.follower.stop()

        // a live log that ends while wanted is started again after 1 s, and not after a stop
        let ending = await started()
        ending.log.end()
        await settle()
        XCTAssertEqual(ending.log.liveStarts, 1, "restarted before the second passed")
        ending.clock.advance(1)
        await settle()
        XCTAssertEqual(ending.log.liveStarts, 2, "not restarted after 1 s")
        ending.follower.stop()
        ending.log.end()
        ending.clock.advance(1)
        await settle()
        XCTAssertEqual(ending.log.liveStarts, 2, "restarted after a stop")

        // no line ever: it stays on the panel it picked
        let silent = await started(lit: [1: false, 3: true])
        silent.clock.advance(30)
        await settle()
        XCTAssertEqual(silent.picks.all, ["inner"], "moved without a line")
        silent.follower.stop()
    }
}
