import CoreVideo
import Foundation
import XCTest

@testable import SimlockCapture

final class EncodeLoopTests: XCTestCase {
    private func picture(_ width: Int, _ height: Int) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any]()] as CFDictionary, &buffer
        )
        return buffer!
    }

    func testAPictureThatChangesSizeGetsANewMetaFrameBeforeItsFirstFrameAndAKeyframe() async throws {
        let cover = (width: 1398, height: 2034)
        let inner = (width: 2853, height: 2007)
        let sizes = [cover, cover, inner, inner, cover]
        let (frames, input) = AsyncStream.makeStream(of: Pending.self)
        for (index, size) in sizes.enumerated() {
            input.yield(Pending(buffer: picture(size.width, size.height), atNanos: UInt64(index) * 100_000_000))
        }
        input.finish()

        nonisolated(unsafe) var written: [(tag: Tag, data: Data)] = []
        Wire.sink = { tag, data in written.append((tag, data)) }
        defer { Wire.sink = nil }
        await encodeLoop(frames, options: Options(), session: Session())

        let metas = try written.filter { $0.tag == .meta }.map { entry -> String in
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: entry.data) as? [String: Any])
            return "\(json["width"] as! Int)x\(json["height"] as! Int)"
        }
        XCTAssertEqual(metas, ["494x720", "720x506", "494x720"])
        let tags = written.map(\.tag)
        for (index, tag) in tags.enumerated() where tag == .meta {
            let first = tags[(index + 1)...].first { $0 == .keyframe || $0 == .delta }
            XCTAssertEqual(first, .keyframe, "the first picture after the meta frame at \(index) is not a keyframe")
        }
        XCTAssertEqual(tags.filter { $0 == .keyframe }.count, 3)
        XCTAssertEqual(tags.filter { $0 == .delta }.count, 2)
    }

    func testACaptureWritesAKeyframeAtLeastEvery5SecondsOfFrameTime() async throws {
        struct Case {
            let name: String
            let step: UInt64
            let count: Int
            /// The frame index at which the picture changes size, if it does.
            let resizeAt: Int?
            /// The exact key-frame times when the encoder's own spacing cannot move them.
            let keyTimes: [Double]?
        }
        let second: UInt64 = 1_000_000_000
        let cases = [
            Case(name: "idle-floor frames for 12 s", step: second / 5, count: 60, resizeAt: nil, keyTimes: [0, 5, 10]),
            Case(name: "30 frames a second for 12 s", step: second / 30, count: 360, resizeAt: nil, keyTimes: nil),
            Case(name: "a size change at 3 s", step: second / 5, count: 60, resizeAt: 15, keyTimes: [0, 3, 8]),
        ]
        for testCase in cases {
            let (frames, input) = AsyncStream.makeStream(of: Pending.self)
            for index in 0..<testCase.count {
                let resized = testCase.resizeAt.map { index >= $0 } ?? false
                input.yield(Pending(
                    buffer: picture(resized ? 1398 : 1179, resized ? 2034 : 2556),
                    atNanos: UInt64(index) * testCase.step
                ))
            }
            input.finish()

            nonisolated(unsafe) var written: [Tag] = []
            Wire.sink = { tag, _ in written.append(tag) }
            defer { Wire.sink = nil }
            await encodeLoop(frames, options: Options(), session: Session())

            let pictures = written.filter { $0 == .keyframe || $0 == .delta }
            XCTAssertEqual(pictures.count, testCase.count, "\(testCase.name): every frame is written")
            let keyTimes = pictures.enumerated().filter { $0.element == .keyframe }
                .map { Double($0.offset) * Double(testCase.step) / Double(second) }
            let end = Double(testCase.count) * Double(testCase.step) / Double(second)
            let gaps = zip(keyTimes, keyTimes.dropFirst().map { $0 } + [end]).map { $1 - $0 }
            XCTAssertLessThanOrEqual(gaps.max() ?? .infinity, 5.2, "\(testCase.name): key frames at \(keyTimes)")
            if let expected = testCase.keyTimes {
                XCTAssertEqual(keyTimes, expected, testCase.name)
            }
            if testCase.resizeAt != nil {
                XCTAssertEqual(written.filter { $0 == .meta }.count, 2, "\(testCase.name): meta")
                XCTAssertEqual(written.filter { $0 == .description }.count, 2, "\(testCase.name): parameter sets")
            }
        }
    }

    func testAt60FpsASourceOfAtLeast60FramesASecondIsWrittenAt60FramesASecond() async throws {
        struct Case {
            let name: String
            /// Arrival times of the source's frames, in nanoseconds.
            let times: [UInt64]
            /// Frames written, from the worked example: 60 a second of source time.
            let expected: Int
        }
        let ms: UInt64 = 1_000_000
        func steady(_ count: Int, every step: UInt64, from start: UInt64 = 0) -> [UInt64] {
            (0..<count).map { start + UInt64($0) * step }
        }
        let jittered = (0..<120).map { index -> UInt64 in
            // 16.2 ms and 17.1 ms in turn: a 60 Hz composite with the jitter the reporter measured.
            UInt64(index / 2) * 33_300_000 + (index % 2 == 0 ? 0 : 16_200_000)
        }
        let cases = [
            Case(name: "100 frames a second for 2 s", times: steady(200, every: 10 * ms), expected: 120),
            Case(name: "90 frames a second for 2 s", times: steady(180, every: 11_111_111), expected: 120),
            Case(name: "60 frames a second with jitter for 2 s", times: jittered, expected: 120),
            Case(
                name: "100 frames a second, a 1 s pause, then 100 a second for 1 s",
                times: steady(50, every: 10 * ms) + steady(100, every: 10 * ms, from: 1_500 * ms),
                expected: 90
            ),
        ]
        var options = Options()
        options.fps = 60
        for testCase in cases {
            let (frames, input) = AsyncStream.makeStream(of: Pending.self)
            for time in testCase.times {
                input.yield(Pending(buffer: picture(360, 720), atNanos: time))
            }
            input.finish()

            nonisolated(unsafe) var written: [Tag] = []
            Wire.sink = { tag, _ in written.append(tag) }
            defer { Wire.sink = nil }
            await encodeLoop(frames, options: options, session: Session())

            let pictures = written.filter { $0 == .keyframe || $0 == .delta }.count
            XCTAssertEqual(Double(pictures), Double(testCase.expected), accuracy: 2, "\(testCase.name): frames written")
        }
    }
}
