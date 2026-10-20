import Foundation
import VideoToolbox
import ImageIO

// Temporary bounded evidence for the user-driven artifact investigation.
// All methods run on the receiver queue; nothing is uploaded.
final class MediaDiagnostics {
    private let directory:URL
    private var packets=Data(), elementary=Data()
    private let began=ProcessInfo.processInfo.systemUptime
    private let limit=16*1024*1024
    private var saved=false
    private var frames=0
    private var enabled:Bool
    init(hardware:Bool) {
        enabled=ProcessInfo.processInfo.environment["DISABLE_MEDIA_DIAGNOSTICS"] != "1"
        directory=Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("work/media-diagnostics/\(Int(Date().timeIntervalSince1970))-\(hardware ? "hardware" : "software")-\(UUID().uuidString.prefix(6))")
        if enabled {
            do {try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
                log("Diagnostics: saving first 8 seconds locally to \(directory.path)")
            } catch {enabled=false;log("Diagnostics: \(error.localizedDescription)")}
        }
    }
    func receive(_ packet:Data) {
        guard enabled,!saved else {return}
        if ProcessInfo.processInfo.systemUptime-began>=8 || packets.count+packet.count+4>limit {finish();return}
        packets.append(contentsOf:HEVCRTPReceiver.word(UInt32(packet.count)));packets.append(packet)
    }
    func accessUnit(_ nals:[Data]) {
        guard enabled,!saved else {return}
        let size=nals.reduce(0){$0+$1.count+4}
        guard elementary.count+size<=limit else {finish();return}
        for nal in nals {elementary.append(contentsOf:[0,0,0,1]);elementary.append(nal)}
    }
    func decoded(_ pixel:CVPixelBuffer) {
        guard enabled,!saved else {return}
        frames+=1
        guard frames==1 || frames==60 || frames==180 else {return}
        var image:CGImage?
        let status=VTCreateCGImageFromCVPixelBuffer(pixel,options:nil,imageOut:&image)
        guard status==0,let image,let destination=CGImageDestinationCreateWithURL(directory.appendingPathComponent("decoded-\(frames).png") as CFURL,"public.png" as CFString,1,nil) else {return}
        CGImageDestinationAddImage(destination,image,nil)
        if !CGImageDestinationFinalize(destination) {log("Diagnostics: could not save decoded frame")}
    }
    func finish() {
        guard enabled,!saved else {return};saved=true
        do {
            try packets.write(to:directory.appendingPathComponent("received.rtpdump"))
            try elementary.write(to:directory.appendingPathComponent("assembled.hevc"))
            log("Diagnostics: saved \(packets.count) packet bytes and \(elementary.count) HEVC bytes")
        } catch {log("Diagnostics: \(error.localizedDescription)")}
        packets=Data();elementary=Data()
    }
}
