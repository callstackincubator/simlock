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
}
