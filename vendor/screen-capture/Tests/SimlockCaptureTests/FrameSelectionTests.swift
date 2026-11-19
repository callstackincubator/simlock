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
        let watch = SeedWatch(
            queue: DispatchQueue(label: "test-seed-watch"),
            readSeed: { seeds[ObjectIdentifier($0)] ?? 0 },
            now: { time },
            onSeed: { surface, seed, at in
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
        callback(first, seed: 7, force: true)
        XCTAssertEqual(noticedSeeds(), [5, 6, 7, 7], "a forced call with an unchanged seed is noticed")

        watch.watch(second)
        seeds[ObjectIdentifier(second)] = 9
        time = 5 * ms
        watch.tick()
        XCTAssertEqual(noticed.last?.seed, 9, "after watch(surface) the next tick reads the new surface")
        XCTAssertEqual(noticed.count, 5)

        watch.stop()
        seeds[ObjectIdentifier(second)] = 10
        watch.tick()
        XCTAssertEqual(noticed.count, 5, "after stop() the tick does nothing")
    }
}
