import CoreVideo
import XCTest

@testable import SimlockCapture
@testable import simlock_screen_capture

final class FrameSelectionTests: XCTestCase {
    private let ms: UInt64 = 1_000_000

    private func composite(at time: UInt64, force: Bool = false, size: (Int, Int) = (1179, 2556)) -> Composite {
        Composite(seenNanos: time, force: force, width: size.0, height: size.1)
    }

    private func copied(_ times: [UInt64], fps: Int = 60) -> Int {
        var selection = FrameSelection(fps: fps)
        return times.filter { selection.decide(composite(at: $0)) }.count
    }

    func testTheSelectionAdmitsByTheGridAndOnlyACopiedCompositeMovesIt() {
        func steady(_ count: Int, every step: UInt64) -> [UInt64] { (0..<count).map { UInt64($0) * step } }
        XCTAssertEqual(copied(steady(200, every: 10 * ms)), 120, "100 a second for 2 s at fps 60")
        XCTAssertEqual(copied(steady(60, every: 33_333_333)), 60, "30 a second for 2 s at fps 60")

        var late = FrameSelection(fps: 60)
        XCTAssertTrue(late.decide(composite(at: 0)), "the first composite")
        XCTAssertTrue(late.decide(composite(at: 200 * ms, force: true)), "a forced composite 200 ms after")
        XCTAssertFalse(late.decide(composite(at: 203 * ms)), "the forced one moved the grid")

        var early = FrameSelection(fps: 60)
        XCTAssertTrue(early.decide(composite(at: 0)))
        XCTAssertTrue(early.decide(composite(at: 5 * ms, force: true)), "a forced composite 5 ms after is copied")
        XCTAssertTrue(early.decide(composite(at: 13 * ms)), "and it did not move the grid")

        var resized = FrameSelection(fps: 60)
        XCTAssertTrue(resized.decide(composite(at: 0)))
        XCTAssertTrue(resized.decide(composite(at: 5 * ms, size: (1398, 2034))), "a new picture size")
    }

    /// A screen of 16 tiles, the first four of them Liquid Glass (changed by every composite).
    private struct Screen {
        var selection = FrameSelection(fps: 60)
        private var values = [UInt64](repeating: 0, count: 16)
        private let ms: UInt64 = 1_000_000
        static let glass = [0, 1, 2, 3]
        static let steady = 8

        /// The screen after ten glass-only composites 10 ms apart, the last at 90 ms.
        static func warmedUp() -> Screen {
            var screen = Screen()
            for step in 0..<10 { _ = screen.next(atMs: UInt64(step) * 10, changing: glass) }
            return screen
        }

        static let sometimes = [4, 5, 6, 7]

        /// Like `warmedUp`, with four tiles that changed on every composite but the fourth.
        static func warmedUpWithSometimesChangingTiles() -> Screen {
            var screen = Screen()
            for step in 0..<10 {
                let moving = step == 3 ? glass : glass + sometimes
                _ = screen.next(atMs: UInt64(step) * 10, changing: moving)
            }
            return screen
        }

        mutating func next(
            atMs time: UInt64, changing tiles: [Int], force: Bool = false, size: (Int, Int) = (1179, 2556)
        ) -> Bool {
            for tile in tiles { values[tile] &+= 1 }
            return selection.decide(
                Composite(seenNanos: time * ms, force: force, width: size.0, height: size.1, tiles: values)
            )
        }
    }

    func testADueCompositeIsCopiedOnlyWhenItCarriesANewAppFrame() {
        var glassOnly = Screen.warmedUp()
        XCTAssertFalse(glassOnly.next(atMs: 100, changing: Screen.glass), "only always-changing tiles, 10 ms after")
        XCTAssertTrue(
            glassOnly.next(atMs: 104, changing: Screen.glass + [Screen.steady]),
            "the slot stayed open, so a steady change 4 ms later is copied"
        )

        var steady = Screen.warmedUp()
        XCTAssertTrue(steady.next(atMs: 100, changing: Screen.glass + [Screen.steady]), "a steady tile changed")

        var half = Screen.warmedUpWithSometimesChangingTiles()
        XCTAssertTrue(
            half.next(atMs: 100, changing: Screen.glass + Screen.sometimes.prefix(2)),
            "half the sometimes-changing tiles changed, none new"
        )
        var fewer = Screen.warmedUpWithSometimesChangingTiles()
        XCTAssertFalse(
            fewer.next(atMs: 100, changing: Screen.glass + Screen.sometimes.prefix(1)),
            "under half the sometimes-changing tiles changed"
        )

        var nearlyDue = Screen.warmedUp()
        XCTAssertTrue(nearlyDue.next(atMs: 103, changing: Screen.glass), "only always-changing tiles, 13 ms after")

        var overdue = Screen.warmedUp()
        XCTAssertFalse(overdue.next(atMs: 100, changing: Screen.glass))
        XCTAssertTrue(overdue.next(atMs: 108, changing: Screen.glass), "only always-changing tiles, 28 ms since the last sent")

        var nothing = Screen.warmedUp()
        XCTAssertFalse(nothing.next(atMs: 96, changing: []), "no tile changed, 6 ms after")

        var first = Screen()
        XCTAssertTrue(first.next(atMs: 0, changing: []), "the first composite")

        var forced = Screen.warmedUp()
        XCTAssertTrue(forced.next(atMs: 100, changing: Screen.glass, force: true), "a forced composite")

        var resized = Screen.warmedUp()
        XCTAssertTrue(resized.next(atMs: 95, changing: Screen.glass, size: (1398, 2034)), "a new picture size")
        XCTAssertTrue(resized.next(atMs: 100, changing: Screen.glass, size: (1398, 2034)), "and its history starts again")

        var scroll = Screen()
        var mirror = FrameGrid(fps: 60)
        for step in 0..<60 {
            let time = UInt64(step) * 10
            let blockChanges = step % 5 < 3
            let due = mirror.isDue(atNanos: time * ms)
            let copied = scroll.next(atMs: time, changing: Screen.glass + (blockChanges ? Screen.sometimes : []))
            if copied { mirror.commit(atNanos: time * ms) }
            if blockChanges, due { XCTAssertTrue(copied, "scroll composite \(step), a due block change") }
        }
    }

    private func picture() -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 360, 720, kCVPixelFormatType_32BGRA, nil, &buffer)
        return buffer!
    }

    /// Runs `composites` through the selection, hands the copied ones to the encode loop the way
    /// `runCapture` does (the loop runs long after the frames were seen), and counts both.
    private func copiedAndWritten(_ composites: [Composite]) async -> (copied: Int, written: Int) {
        var selection = FrameSelection(fps: 60)
        let (frames, input) = AsyncStream.makeStream(of: Pending.self)
        var copied = 0
        for composite in composites where selection.decide(composite) {
            copied += 1
            input.yield(pending(picture(), seenNanos: composite.seenNanos))
        }
        input.finish()
        nonisolated(unsafe) var written = 0
        Wire.sink = { tag, _ in if tag == .keyframe || tag == .delta { written += 1 } }
        defer { Wire.sink = nil }
        var options = Options()
        options.fps = 60
        await encodeLoop(frames, options: options, session: Session())
        return (copied, written)
    }

    func testEveryFrameTheCaptureCopiesIsWrittenByTheEncodeLoopBecauseBothJudgeTheSameSeenTime() async {
        XCTAssertEqual(pending(picture(), seenNanos: 7).atNanos, 7, "a frame keeps its seen time")

        let steady = (0..<200).map { composite(at: UInt64($0) * 10 * ms) }
        var result = await copiedAndWritten(steady)
        XCTAssertEqual(result.written, result.copied, "100 a second for 2 s")
        result = await copiedAndWritten((0..<60).map { composite(at: UInt64($0) * 33_333_333) })
        XCTAssertEqual(result.written, result.copied, "30 a second for 2 s")
        result = await copiedAndWritten([composite(at: 0), composite(at: 200 * ms, force: true)])
        XCTAssertEqual(result.written, result.copied, "a forced composite 200 ms after")
        result = await copiedAndWritten([composite(at: 0), composite(at: 5 * ms, force: true)])
        XCTAssertEqual(result.copied, 2, "a forced composite under one interval is copied")
        XCTAssertEqual(result.written, 1, "and the encode loop drops it")
        result = await copiedAndWritten([composite(at: 0), composite(at: 20 * ms, size: (1398, 2034))])
        XCTAssertEqual(result.written, result.copied, "a new picture size")
    }

    func testTheCopyStageDecidesBeforeItCopiesAndHandsOverTheSeenTime() {
        let surface = IOSurface(properties: [
            .width: 360, .height: 720, .bytesPerElement: 4, .pixelFormat: kCVPixelFormatType_32BGRA,
        ])!
        nonisolated(unsafe) var seen: [UInt64] = []
        let stage = CopyStage(fps: 60) { _, nanos in seen.append(nanos) }
        func offer(at time: UInt64) {
            stage.offer(Notice(surface: surface, seed: IOSurfaceGetSeed(surface), seenNanos: time, force: false))
            stage.queue.sync {}
        }
        offer(at: 0)
        offer(at: 5 * ms)
        offer(at: 20 * ms)
        stage.stop()
        XCTAssertEqual(seen, [0, 20 * ms], "the 5 ms composite is declined before any copy, the others keep their seen time")
    }

    func testEachNewSeedIsNoticedOnceWhetherTheCallbackOrTheTickSeesItFirst() {
        func surface() -> IOSurface {
            IOSurface(properties: [
                .width: 8, .height: 8, .bytesPerElement: 4, .pixelFormat: kCVPixelFormatType_32BGRA,
            ])!
        }
        let first = surface()
        let second = surface()
        nonisolated(unsafe) var seeds: [ObjectIdentifier: UInt32] = [:]
        nonisolated(unsafe) var time: UInt64 = 0
        nonisolated(unsafe) var noticed: [(seed: UInt32, at: UInt64)] = []
        nonisolated(unsafe) var gate = SeedGate()
        nonisolated(unsafe) var reports: [(seed: UInt32, at: UInt64)] = []
        let watch = SeedWatch(
            queue: DispatchQueue(label: "test-seed-watch"),
            readSeed: { seeds[ObjectIdentifier($0)] ?? 0 },
            now: { time },
            onSeed: { surface, seed, at in
                reports.append((seed, at))
                if gate.notice(key: ObjectIdentifier(surface), seed: seed, force: false) {
                    noticed.append((seed, at))
                }
            }
        )
        func callback(_ surface: IOSurface, seed: UInt32, force: Bool = false) {
            if gate.notice(key: ObjectIdentifier(surface), seed: seed, force: force) {
                noticed.append((seed, time))
            }
        }
        func noticedSeeds() -> [UInt32] { noticed.map(\.seed) }

        watch.watch(first)
        seeds[ObjectIdentifier(first)] = 5
        time = 1 * ms
        watch.tick()
        seeds[ObjectIdentifier(first)] = 6
        time = 2 * ms
        watch.tick()
        XCTAssertEqual(noticedSeeds(), [5, 6], "two seeds between two callbacks are both noticed")
        XCTAssertEqual(noticed.map(\.at), [1 * ms, 2 * ms], "each with its own time")

        callback(first, seed: 6)
        XCTAssertEqual(noticedSeeds(), [5, 6], "the callback on a seed the tick noticed is not a second notice")
        callback(first, seed: 7)
        time = 3 * ms
        seeds[ObjectIdentifier(first)] = 7
        watch.tick()
        XCTAssertEqual(noticedSeeds(), [5, 6, 7], "the tick on a seed the callback noticed is not a second notice")

        time = 4 * ms
        watch.tick()
        XCTAssertEqual(noticedSeeds(), [5, 6, 7], "an unchanged seed is not noticed")
        XCTAssertEqual(reports.map(\.seed), [5, 6, 7], "the tick does not even report an unchanged seed")
        callback(first, seed: 7, force: true)
        XCTAssertEqual(noticedSeeds(), [5, 6, 7, 7], "a forced call with an unchanged seed is noticed")

        watch.watch(second)
        seeds[ObjectIdentifier(second)] = 9
        time = 5 * ms
        watch.tick()
        XCTAssertEqual(noticed.last?.seed, 9, "after watch(surface) the next tick reads the new surface")
        XCTAssertEqual(noticed.count, 5)
        XCTAssertEqual(reports.map(\.at), [1 * ms, 2 * ms, 3 * ms, 5 * ms], "each report carries the time the tick read it")

        watch.stop()
        seeds[ObjectIdentifier(second)] = 10
        watch.tick()
        watch.watch(second)
        watch.tick()
        XCTAssertEqual(reports.count, 4, "after stop() the tick does nothing, even for a surface watched afterwards")
    }
}
