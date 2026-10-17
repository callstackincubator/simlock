import AppKit
import AVFoundation
import CoreDevice
import Network

private final class LatestVideoFrame: @unchecked Sendable {
    private let lock=NSLock()
    private var pixel:CVPixelBuffer?
    private var scheduled=false
    func submit(_ image:CVPixelBuffer, present:@escaping @MainActor (CVPixelBuffer)->Void) {
        lock.lock();pixel=image
        let enqueue = !scheduled
        scheduled=true;lock.unlock()
        guard enqueue else {return}
        DispatchQueue.main.async { [self] in
            lock.lock();let image=pixel;pixel=nil;scheduled=false;lock.unlock()
            if let image {present(image)}
        }
    }
}

@MainActor
final class NetworkMirror {
    private(set) var layer: AVSampleBufferDisplayLayer?
    private(set) var videoSize: CGSize?
    private var task: Task<Void,Never>?
    private var receiverTask: Task<Void,Error>?
    private var generation=UUID()
    private var displayed=0

    func start(device:RemoteDevice,into host:CALayer,useHardware:Bool,onPrepared:@escaping @MainActor () async -> Void,onState:@escaping(String)->Void,onFinished:@escaping()->Void) {
        guard task==nil else {return}
        let display=AVSampleBufferDisplayLayer()
        display.videoGravity = .resizeAspect
        display.frame=host.bounds
        host.addSublayer(display);layer=display
        generation=UUID();let run=generation
        displayed=0
        task=Task { [self] in
            var token:UInt32?
            var usageAssertion:DeviceUsageAssertion?
            var stage="preparing device services"
            defer {
                probeClose()
                receiverTask=nil;task=nil
                usageAssertion?.releaseAssertion()
                if usageAssertion != nil {log("Device preparation: usage assertion released")}
                if generation==run {layer?.removeFromSuperlayer();layer=nil;videoSize=nil}
                onFinished()
            }
            do {
                onState("Preparing device connection and developer services…")
                log("Device preparation: requesting CoreDevice services, device information, trusted discovery and secure networking")
                let requirements=UsageAssertionRequirements(deviceStates:[
                    .developerModeEnabledIfRequired,
                    .coreDeviceServicesLoaded,
                    .extendedDeviceInfoLoaded,
                    .remoteServiceDiscoveryTrustedConnectivityAvailable,
                    .secureNetworkingAvailable
                ],capabilities:[])
                usageAssertion=try await device.acquireDeviceUsageAssertion(withReason:"DeviceStreamPoC screen mirroring",requirements:requirements)
                try Task.checkCancellation()
                usageAssertion?.registerInvalidationHandler(invokingOnQueue:.main) { [weak self] error in
                    // Explicit release on Stop is expected; report unexpected service loss.
                    guard let error else {return}
                    Task { @MainActor [weak self] in
                        guard let self,self.generation==run,self.task != nil else {return}
                        log("Device preparation: usage assertion invalidated: \(error)")
                        onState("Device connection lost: \(error.localizedDescription)")
                        self.stop()
                    }
                }
                log("Device preparation: services ready; usage assertion held for this mirror session")
                await onPrepared()
                try Task.checkCancellation()
                stage="querying media support"
                var options=MediaStreamHelper.getNegotiatorOptions(for:device.deviceInfo)
                options[DeviceMediaStream.kAVCMediaStreamOptionClientName]="CoreDeviceScreenSharing"
                options[DeviceMediaStream.kAVCMediaStreamOptionClientSessionID]=UUID()
                options["avcMediaStreamOptionCallID"]=UUID().uuidString
                guard let negotiator=probeNegotiator(options,5),let offer=probeOffer(negotiator) else {throw failure("Could not create the media offer")}
                let support=try await device.mediaStreamSupportInfo
                try Task.checkCancellation()
                guard let tunnel=device.deviceInfo.tunnelIPAddressString,let local=probeBind(tunnel) else {throw failure("No paired device tunnel is available")}
                stage="starting media stream"
                let response=try await device.startMediaStream(with:.init(timeout:15,type:.video,direction:.output,negotiatorOffer:offer,clientSupportedFeatures:support.client.supportedFeatures,receiverIP:local,receiverPort:probePort(),options:options.compactMapValues{CodableValue($0)}))
                token=UInt32(exactly:response.connection.streamConfig.StreamInputID)
                stage="configuring media receiver"
                try Task.checkCancellation()
                guard let config=probeAnswer(negotiator,response.negotiatorAnswer), (config["vcMediaStreamSRTPCipherSuite"] as? NSNumber)?.intValue==0 else {throw failure("Unsupported encrypted media configuration")}
                // Read numeric configuration through Encodable, avoiding guessed Swift struct layout.
                let json=try JSONSerialization.jsonObject(with:JSONEncoder().encode(response.connection)) as? [String:Any]
                let streamConfig=json?["streamConfig"] as? [String:Any]
                let summary=["IsltrpEnabled","KeyFrameInterval","VideoStreamMode","Framerate","RxCodecFeatureListString"].map { "\($0)=\(streamConfig?[$0] ?? "?")" }.joined(separator:" ")
                log("Network mirror: negotiated stream config: \(summary)")
                guard let localSSRC=(streamConfig?["RemoteSSRC"] as? NSNumber)?.uint32Value,
                      let source=IPv6Address(local),let destination=IPv6Address(response.connection.sender.ipv6Address) else {throw failure("Invalid negotiated endpoints")}
                probeClose()
                try NetworkUtils.withSharedSocketDictionary(sourceAddress:source,port:response.connection.receiver.port,remoteAddress:destination,remotePort:response.connection.sender.port) {probeAdopt($0)}
                log("Network mirror: started over \(device.deviceInfo.transportType?.description ?? "tunnel"); local HEVC decoder, no conferencing entitlement")
                onState("Connected — waiting for video…")
                let worker=Task.detached(priority:.userInitiated) { [weak self] in
                    let parser=HEVCRTPReceiver(),decoder=HEVCDecoder(useHardware:useHardware)
                    let latestFrame=LatestVideoFrame()
                    let diagnostics=MediaDiagnostics(hardware:useHardware)
                    defer {diagnostics.finish()}
                    var lastPLI=0.0,lastReport=0.0,lastPacket=ProcessInfo.processInfo.systemUptime
                    var keyframeRequests=0
                    var packets=0,bytes=0,lastStats=lastPacket
                    let began=lastPacket
                    decoder.onConfiguration={message in log(message)}
                    parser.onLoss={decoder.invalidateReferences()}
                    decoder.onFailure={message in log("HEVC: \(message)")}
                    // Retain only the latest decoded frame. Never wait on AppKit from the socket reader.
                    decoder.onFrame={pixel in
                        diagnostics.decoded(pixel)
                        latestFrame.submit(pixel) { [weak self] image in self?.present(image,run:run,onState:onState) }
                    }
                    parser.onAccessUnit={nals,ts in diagnostics.accessUnit(nals);decoder.decode(nals,timestamp:ts)}
                    defer {_ = probeSend(parser.report(receiver:localSSRC,bye:true))}
                    while !Task.isCancelled {
                        if let data=probeReceive(5) {packets+=1;bytes+=data.count;lastPacket=ProcessInfo.processInfo.systemUptime;diagnostics.receive(data);parser.receive(data)}
                        parser.flushPending()
                        let now=ProcessInfo.processInfo.systemUptime
                        let pli=decoder.needsKeyframe && parser.source != nil && now-lastPLI>=0.5
                        if now-lastReport>=1 || pli {
                            guard probeSend(parser.report(receiver:localSSRC,requestKeyframe:pli)) else {throw Self.failure("Media socket closed while sending RTCP")}
                            lastReport=now
                            if pli {keyframeRequests+=1;lastPLI=now}
                        }
                        if now-lastStats>=5 {
                            log("Network mirror: \(decoder.decoded) decoded frames, \(packets) datagrams, \(bytes) bytes, \(Int(now-began))s; loss=\(parser.lossEvents), reordered=\(parser.reorderedPackets), late=\(parser.latePackets), keyframe requests=\(keyframeRequests), units=\(decoder.accessUnits), submitted=\(decoder.submitted), decoder dropped=\(decoder.decoderDropped), waiting=\(decoder.waitingForKeyframe)")
                            lastStats=now
                        }
                        if now-lastPacket>10 {throw Self.failure("No media received for 10 seconds. Check that the device is awake and reachable.")}
                        if now-began>10 && decoder.decoded==0 {throw Self.failure("Packets arrived but no HEVC frame could be decoded")}
                    }
                    log("Network mirror: receiver stopped after \(decoder.decoded) decoded frames")
                }
                receiverTask=worker
                stage="receiving video"
                try await worker.value
            } catch is CancellationError {log("Network mirror: cancelled")}
              catch {log("Network mirror failed while \(stage): \(error)");onState("Failed while \(stage): \(error.localizedDescription)")}
            if let token {
                // Stop only this session; never stop unrelated DeviceHub streams.
                do {_ = try await device.stopMediaStream(with:.init(stopAll:false,identifiers:[token]));log("Network mirror: remote stop requested (\(token))")}
                catch {log("Network mirror: remote stop failed: \(error)")}
            }
        }
    }
    private func present(_ pixel:CVPixelBuffer,run:UUID,onState:(String)->Void) {
        guard generation==run,let layer else {return}
        var format:CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:pixel,formatDescriptionOut:&format)==0,let format else {return}
        var timing=CMSampleTimingInfo(duration:.invalid,presentationTimeStamp:CMTime(value:Int64(displayed),timescale:60),decodeTimeStamp:.invalid)
        var sample:CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator:kCFAllocatorDefault,imageBuffer:pixel,formatDescription:format,sampleTiming:&timing,sampleBufferOut:&sample)==0,let sample else {return}
        if let attachments=CMSampleBufferGetSampleAttachmentsArray(sample,createIfNecessary:true) {
            let dictionary=unsafeBitCast(CFArrayGetValueAtIndex(attachments,0),to:CFMutableDictionary.self)
            CFDictionarySetValue(dictionary,Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        if layer.status == .failed {log("Preview: \(layer.error?.localizedDescription ?? "display failed")");layer.flush()}
        if layer.isReadyForMoreMediaData {layer.enqueue(sample);displayed+=1}
        let size=CGSize(width:CVPixelBufferGetWidth(pixel),height:CVPixelBufferGetHeight(pixel))
        if videoSize != size || displayed==1 {
            videoSize=size
            log("Network mirror: first decoded/displayed frame \(Int(size.width))×\(Int(size.height))")
            onState("Mirroring over CoreDevice — \(Int(size.width))×\(Int(size.height)) HEVC. Click or drag to touch.")
        }
    }
    func layout(in host:CALayer) {layer?.frame=host.bounds}
    func normalizedPoint(_ point:CGPoint,in bounds:CGRect)->CGPoint? {
        guard layer != nil,let size=videoSize else {return nil}
        let scale=min(bounds.width/size.width,bounds.height/size.height)
        let rect=CGRect(x:(bounds.width-size.width*scale)/2,y:(bounds.height-size.height*scale)/2,width:size.width*scale,height:size.height*scale)
        guard rect.contains(point) else {return nil}
        return CGPoint(x:(point.x-rect.minX)/rect.width,y:1-(point.y-rect.minY)/rect.height)
    }
    func stop() {
        generation=UUID()
        task?.cancel();receiverTask?.cancel()
        layer?.removeFromSuperlayer();layer=nil;videoSize=nil
    }
    nonisolated private static func failure(_ message:String)->NSError {NSError(domain:"NetworkMirror",code:1,userInfo:[NSLocalizedDescriptionKey:message])}
    private func failure(_ message:String)->NSError {Self.failure(message)}
}
