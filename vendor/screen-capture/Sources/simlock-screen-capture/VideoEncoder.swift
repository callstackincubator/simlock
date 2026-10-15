import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Writes one frame as a JPEG, which is all the MJPEG codec is: a stream of
/// independently encoded stills with nothing between them to predict from.
///
/// Every frame here is a keyframe, so MJPEG costs far more bandwidth than H.264 for the
/// same picture. It is the fallback for a viewer that cannot be handed an H.264 decoder,
/// which is why it exists despite that.
actor VideoEncoder {
    /// JPEG quality, 0…1.
    private let quality: CGFloat

    init(quality: CGFloat = 0.7) {
        self.quality = quality
    }

    /// Encoding is synchronous CPU work — a whole-frame DCT — so it runs on its own
    /// serial queue rather than on the caller's thread. Left on the actor's default
    /// executor it would occupy a thread of the cooperative pool, and that pool is sized
    /// to the core count for code that never blocks.
    private let queue = DispatchSerialQueue(label: "video-encoder", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    /// The JPEG bytes for one frame.
    func encode(pixelBuffer: CVPixelBuffer) throws -> Data {
        let image = try cgImage(from: pixelBuffer)

        let jpeg = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            jpeg as CFMutableData,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            throw Errors.encodingFailed
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else {
            throw Errors.encodingFailed
        }
        return jpeg as Data
    }

    /// A `CGImage` over the frame's pixels.
    ///
    /// Nothing is copied here: the bitmap context is handed the buffer's own base address,
    /// and `makeImage()` produces an image that reads through it. Hence the lock, held for
    /// the call — a buffer's base address is only meaningful while it is locked, and the
    /// image has to have been created before the lock goes back.
    private func cgImage(from pixelBuffer: CVPixelBuffer) throws -> CGImage {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw Errors.invalidPixelBuffer
        }
        guard let context = CGContext(
            data: baseAddress,
            width: CVPixelBufferGetWidth(pixelBuffer),
            height: CVPixelBufferGetHeight(pixelBuffer),
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            // BGRA in memory, read as a pre-multiplied 32-bit little-endian pixel: what
            // the capture path asks the framebuffer for (kCVPixelFormatType_32BGRA). The
            // two flags are the same choice spelled in CoreGraphics' terms, and the
            // pairing is the one CoreGraphics rejects any other combination of.
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue
                | CGImageAlphaInfo.premultipliedFirst.rawValue
        ), let image = context.makeImage() else {
            throw Errors.encodingFailed
        }
        return image
    }

    enum Errors: Error {
        case invalidPixelBuffer
        case encodingFailed
    }
}
