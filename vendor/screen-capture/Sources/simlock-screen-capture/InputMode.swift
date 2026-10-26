// simlock's own, MIT-licensed (see NOTICE.md): the input mode of `simlock-screen-capture`.
//
// `simlock-screen-capture <UDID> --input` writes no picture. It sets up serve-sim's HID injector for
// one simulator, tells the daemon the device's native size once, then injects what the daemon sends on
// stdin. Each message is the stream's envelope: a 4-byte big-endian length (covering the tag), a tag
// byte, and serve-sim's JSON for that tag:
//
//   0x03 touch   {"type":"begin"|"move"|"end","x":0..1,"y":0..1}
//   0x06 key     {"type":"down"|"up","usage":<USB HID keyboard usage>}
//   0x0b scroll  {"dx":-1..1,"dy":-1..1,"x"?:0..1,"y"?:0..1}  (fractions of the screen)
//
// stdout carries one envelope, tag 0x82, `{"width":<px>,"height":<px>}`, once the HID client exists.
// End of stdin ends the program, as it ends a capture. Home is not here: the daemon relaunches
// SpringBoard with `simctl`, which is what serve-sim does on Xcode 26 and later.
import Foundation
import SimlockCapture

private let tagTouch: UInt8 = 0x03
private let tagKey: UInt8 = 0x06
private let tagScroll: UInt8 = 0x0b
private let tagConfig: UInt8 = 0x82

/// Reads exactly `count` bytes from stdin, or nil when stdin has ended.
private func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        guard let chunk = try? FileHandle.standardInput.read(upToCount: count - data.count),
              !chunk.isEmpty else { return nil }
        data.append(chunk)
    }
    return data
}

private func emitConfig(width: Int, height: Int) {
    let body = (try? JSONSerialization.data(withJSONObject: ["width": width, "height": height])) ?? Data()
    let total = UInt32(body.count + 1)
    var out = Data()
    for shift in [24, 16, 8, 0] { out.append(UInt8((total >> UInt32(shift)) & 0xff)) }
    out.append(tagConfig)
    out.append(body)
    out.withUnsafeBytes { pointer in
        var written = 0
        while written < out.count {
            let n = write(Wire.fd, pointer.baseAddress! + written, out.count - written)
            if n <= 0 { return }
            written += n
        }
    }
}

func runInput(udid: String) async -> Never {
    let injector = HIDInjector()
    do {
        try await injector.setup(deviceUDID: udid)
    } catch {
        fail("could not set up input for \(udid): \(error.localizedDescription)")
    }
    guard let device = FrameCapture.findSimDevice(udid: udid),
          let size = FrameCapture.nativeScreenSizes(for: device).first else {
        fail("could not read the screen size of \(udid)")
    }
    emitConfig(width: size.width, height: size.height)

    while let header = readExactly(4) {
        let length = header.reduce(0) { ($0 << 8) | Int($1) }
        guard length >= 1, let message = readExactly(length) else { break }
        let tag = message[message.startIndex]
        guard let fields = try? JSONSerialization.jsonObject(with: message.dropFirst()) as? [String: Any]
        else { continue }
        switch tag {
        case tagTouch:
            guard let type = fields["type"] as? String,
                  let x = fields["x"] as? Double, let y = fields["y"] as? Double else { continue }
            await injector.sendTouch(type: type, x: x, y: y, screenWidth: size.width, screenHeight: size.height)
        case tagKey:
            guard let type = fields["type"] as? String, let usage = fields["usage"] as? Int, usage >= 0 else { continue }
            await injector.sendKey(type: type, usage: UInt32(usage))
        case tagScroll:
            guard let dx = fields["dx"] as? Double, let dy = fields["dy"] as? Double else { continue }
            // The injector takes pixel deltas; the daemon sends fractions of the screen.
            // why: sendScroll sleeps to end the drag after the wheel idles; awaiting it would
            // make every message its own drag and hold stdin, so calls overlap on the actor.
            let anchorX = fields["x"] as? Double, anchorY = fields["y"] as? Double
            Task {
                await injector.sendScroll(
                    dx: dx * Double(size.width), dy: dy * Double(size.height),
                    anchorX: anchorX, anchorY: anchorY,
                    screenWidth: size.width, screenHeight: size.height)
            }
        default:
            continue
        }
    }
    log("stdin closed")
    exit(0)
}
