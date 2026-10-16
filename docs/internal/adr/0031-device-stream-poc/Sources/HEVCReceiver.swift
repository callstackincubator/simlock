import Foundation
import VideoToolbox

// Single-stream receiver with bounded packet reordering. Loss discards the whole access unit.
// HEVC RTP payloads follow RFC 7798 (single NAL, AP and FU, without DONL).
final class HEVCRTPReceiver {
    var onAccessUnit: ([Data], UInt32) -> Void = { _, _ in }
    var onLoss: () -> Void = {}
    private var pending: [UInt16:(data:Data,arrival:TimeInterval)] = [:]
    private var nextExpected: UInt16?
    private let reorderDelay: TimeInterval = 0.025
    private(set) var reorderedPackets = 0
    private(set) var latePackets = 0
    private(set) var lossEvents = 0
    private var sequence: UInt16?
    private var timestamp: UInt32?
    private var fragment = Data()
    private var nals: [Data] = []
    private var damaged = false
    private var unitBytes = 0
    private(set) var source: UInt32?
    private(set) var received: UInt32 = 0
    private(set) var highest: UInt32 = 0
    private var base: UInt32 = 0
    private var previousExpected: UInt32 = 0
    private var previousReceived: UInt32 = 0
    private var lastSR: UInt32 = 0
    private var lastSRTime: TimeInterval = 0
    private var transit: Double?
    private var jitter = 0.0
    private let maxUnitBytes = 8 * 1024 * 1024
    static func u16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) << 8 | UInt16(b[i+1]) }
    static func u32(_ b: [UInt8], _ i: Int) -> UInt32 { UInt32(u16(b,i)) << 16 | UInt32(u16(b,i+2)) }
    static func word(_ n: UInt32) -> [UInt8] { [UInt8(truncatingIfNeeded:n >> 24),UInt8(truncatingIfNeeded:n >> 16),UInt8(truncatingIfNeeded:n >> 8),UInt8(truncatingIfNeeded:n)] }
    private func lose() { fragment.removeAll(keepingCapacity:true); nals.removeAll(keepingCapacity:true); unitBytes=0; damaged=true; lossEvents+=1; onLoss() }
    func receive(_ data: Data) {
        let bytes=Array(data.prefix(12))
        guard bytes.count>=12,bytes[0]>>6==2 else {return}
        // RTCP has its own sequence space and must never enter the RTP reorder buffer.
        guard bytes[1]&127==100 else {receiveOrdered(data);return}
        let sender=Self.u32(bytes,8)
        guard source==nil || source==sender else {return}
        if source==nil {source=sender}
        let seq=Self.u16(bytes,2)
        if nextExpected==nil {nextExpected=seq}
        guard let expected=nextExpected else {return}
        let distance=Int16(bitPattern:seq &- expected)
        guard distance>=0 else {latePackets+=1;return}
        guard pending[seq]==nil else {return}
        if distance>0 {reorderedPackets+=1}
        pending[seq]=(data,ProcessInfo.processInfo.systemUptime)
        flushPending()
    }
    func flushPending() {
        while let expected=nextExpected {
            if let packet=pending.removeValue(forKey:expected) {
                nextExpected=expected &+ 1
                receiveOrdered(packet.data)
                continue
            }
            guard !pending.isEmpty else {return}
            let oldest=pending.values.map(\.arrival).min()!
            guard pending.count>=256 || ProcessInfo.processInfo.systemUptime-oldest>=reorderDelay else {return}
            // The gap is now real; receiveOrdered will invalidate the affected access unit.
            nextExpected=pending.keys.min { ($0 &- expected)<($1 &- expected) }
        }
    }
    private func receiveOrdered(_ data: Data) {
        let b=Array(data)
        guard b.count>=4, b[0]>>6==2 else {return}
        if b[1]>=192 && b[1]<=223 {
            var offset=0
            while offset+4<=b.count {
                let length=(Int(Self.u16(b,offset+2))+1)*4
                guard length>=4,offset+length<=b.count else {return}
                if b[offset+1]==200, length>=28 {
                    let sender=Self.u32(b,offset+4)
                    if source==nil || source==sender {
                        lastSR=(Self.u32(b,offset+8)<<16)|(Self.u32(b,offset+12)>>16)
                        lastSRTime=ProcessInfo.processInfo.systemUptime
                    }
                }
                offset+=length
            }
            return
        }
        guard b.count>=12, b[1]&127==100 else {return}
        let sender=Self.u32(b,8)
        guard source==nil || source==sender else {return}
        source=sender
        let seq=Self.u16(b,2), ts=Self.u32(b,4)
        var offset=12+Int(b[0]&15)*4
        guard offset<=b.count else {return}
        if b[0]&16 != 0 {
            guard offset+4<=b.count else {return}
            offset+=4+Int(Self.u16(b,offset+2))*4
        }
        var end=b.count
        if b[0]&32 != 0 {
            let pad=Int(b.last!)
            guard pad>0,pad<=end-offset else {return}
            end-=pad
        }
        guard offset+2<=end else {return}
        var sequenceGap=false
        if let previous=sequence {
            let distance=Int16(bitPattern:seq &- previous)
            guard distance>0 else {return} // Ignore duplicates.
            highest &+= UInt32(distance)
            if distance != 1 { sequenceGap=true }
        } else { highest=UInt32(seq); base=highest }
        sequence=seq; received &+= 1
        // Differences avoid unsigned timestamp wrap during long sessions.
        let now=ProcessInfo.processInfo.systemUptime
        let currentTransit=now*90000-Double(ts)
        if let old=transit { let delta=abs(currentTransit-old); if delta<900000 {jitter+=(delta-jitter)/16} }
        transit=currentTransit
        if timestamp != ts {
            if timestamp != nil && (!nals.isEmpty || !fragment.isEmpty) { lossEvents+=1;onLoss() }
            nals.removeAll(keepingCapacity:true);fragment.removeAll(keepingCapacity:true);unitBytes=0;damaged=false;timestamp=ts
        }
        // Apply loss AFTER the timestamp reset: a gap may include the first slices of this frame.
        if sequenceGap {lose()}
        let payload=Array(b[offset..<end]), kind=(payload[0]>>1)&63
        if !damaged {
            switch kind {
            case 0..<48:
                if !fragment.isEmpty {lose()} else {append(Data(payload))}
            case 48:
                var i=2
                while i<payload.count && !damaged {
                    guard i+2<=payload.count else {lose();break}
                    let length=Int(Self.u16(payload,i));i+=2
                    guard length>=2,i+length<=payload.count else {lose();break}
                    append(Data(payload[i..<i+length]));i+=length
                }
            case 49:
                guard payload.count>=4 else {lose();return}
                let fu=payload[2]
                if fu&128 != 0 {
                    if !fragment.isEmpty {lose();return}
                    fragment=Data([(payload[0]&129)|((fu&63)<<1),payload[1]])
                }
                guard !fragment.isEmpty else {lose();return}
                guard fragment.count+payload.count-3<=maxUnitBytes else {lose();return}
                fragment.append(contentsOf:payload.dropFirst(3))
                if fu&64 != 0 {let nal=fragment;fragment.removeAll(keepingCapacity:true);append(nal)}
            default: lose()
            }
        }
        if b[1]&128 != 0 {
            if !fragment.isEmpty {lose()}
            // A complete picture must include its first slice, including when joining mid-stream.
            let slices=nals.filter { ($0[$0.startIndex]>>1)&63 < 32 }
            if !slices.isEmpty && !slices.contains(where: {$0.count>=3 && $0[$0.startIndex+2]&128 != 0}) {lose()}
            if !damaged && !nals.isEmpty {onAccessUnit(nals,ts)}
            nals.removeAll(keepingCapacity:true);unitBytes=0
        }
    }
    private func append(_ nal:Data) {
        guard unitBytes+nal.count<=maxUnitBytes else {lose();return}
        nals.append(nal);unitBytes+=nal.count
    }
    func report(receiver: UInt32, requestKeyframe: Bool = false, bye: Bool = false) -> Data {
        let w=Self.word
        var b:[UInt8]
        if let source {
            let expected=highest &- base &+ 1
            let interval=expected &- previousExpected
            let got=received &- previousReceived
            let lost=max(Int64(expected)-Int64(received),0)
            let fraction=interval>0 ? min(255,max(0,(Int64(interval)-Int64(got))*256/Int64(interval))):0
            let total=UInt32(min(lost,0x7fffff))
            let delay=lastSR==0 ? 0:UInt32(min((ProcessInfo.processInfo.systemUptime-lastSRTime)*65536,Double(UInt32.max)))
            b=[0x81,201,0,7]+w(receiver)+w(source)+[UInt8(fraction),UInt8(truncatingIfNeeded:total>>16),UInt8(truncatingIfNeeded:total>>8),UInt8(truncatingIfNeeded:total)]+w(highest)+w(UInt32(jitter))+w(lastSR)+w(delay)
            previousExpected=expected;previousReceived=received
        } else {b=[0x80,201,0,1]+w(receiver)}
        let name=Array("DeviceStreamPoC".utf8)
        var chunk=w(receiver)+[1,UInt8(name.count)]+name+[0]
        while chunk.count%4 != 0 {chunk.append(0)}
        b += [0x81,202,0,UInt8(chunk.count/4)]+chunk
        if requestKeyframe,let source {b += [0x81,206,0,2]+w(receiver)+w(source)}
        if bye {b += [0x81,203,0,1]+w(receiver)}
        return Data(b)
    }
}

final class HEVCDecoder {
    private let useHardware:Bool
    var onConfiguration:(String)->Void = {_ in}
    init(useHardware:Bool = false) {self.useHardware=useHardware}
    private var parameterSets: [UInt8:Data] = [:]
    private var format: CMVideoFormatDescription?
    private var session: VTDecompressionSession?
    private(set) var needsKeyframe=true
    private var discardLeadingPictures=false
    private(set) var decoded=0
    private(set) var submitted=0
    private(set) var decoderDropped=0
    private(set) var waitingForKeyframe=0
    private(set) var accessUnits=0
    var onFrame: (CVPixelBuffer) -> Void = {_ in}
    var onFailure: (String) -> Void = {_ in}
    deinit { if let session {VTDecompressionSessionInvalidate(session)} }
    func invalidateReferences() {
        needsKeyframe=true
        if let session {VTDecompressionSessionInvalidate(session)}
        session=nil
    }
    func decode(_ nals:[Data], timestamp:UInt32) {
        accessUnits+=1
        var picture=[Data](), randomAccess=false, changed=false, sliceTypes=[UInt8]()
        for nal in nals {
            guard nal.count>=2 else {continue}
            let type=(nal[nal.startIndex]>>1)&63
            if (32...34).contains(type) {
                if parameterSets[type] != nal {parameterSets[type]=nal;changed=true}
            } else {picture.append(nal);if type<32 {sliceTypes.append(type)};if (16...21).contains(type) {randomAccess=true}}
        }
        if changed {if let session {VTDecompressionSessionInvalidate(session)};session=nil;format=nil;needsKeyframe=true}
        guard !sliceTypes.isEmpty else {return}
        guard !needsKeyframe || randomAccess else {waitingForKeyframe+=1;return}
        // RASL pictures following an open-GOP recovery point may reference the discarded past.
        if discardLeadingPictures && sliceTypes.contains(where: {$0==8 || $0==9}) {return}
        if needsKeyframe && randomAccess {discardLeadingPictures=true}
        else if sliceTypes.contains(where: {$0<6}) {discardLeadingPictures=false}
        do {
            if session==nil {try configure()}
            guard let session,let format else {return}
            var bytes=Data()
            for nal in picture {bytes.append(contentsOf:HEVCRTPReceiver.word(UInt32(nal.count)));bytes.append(nal)}
            var block:CMBlockBuffer?
            try check(CMBlockBufferCreateWithMemoryBlock(allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:bytes.count,blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,dataLength:bytes.count,flags:0,blockBufferOut:&block),"block allocation")
            guard let block else {return}
            try bytes.withUnsafeBytes {raw in try check(CMBlockBufferReplaceDataBytes(with:raw.baseAddress!,blockBuffer:block,offsetIntoDestination:0,dataLength:bytes.count),"block copy")}
            var timing=CMSampleTimingInfo(duration:.invalid,presentationTimeStamp:CMTime(value:Int64(timestamp),timescale:90000),decodeTimeStamp:.invalid)
            var size=bytes.count,sample:CMSampleBuffer?
            try check(CMSampleBufferCreateReady(allocator:kCFAllocatorDefault,dataBuffer:block,formatDescription:format,sampleCount:1,sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleSizeEntryCount:1,sampleSizeArray:&size,sampleBufferOut:&sample),"compressed sample")
            guard let sample else {return}
            // CoreMedia assumes sync samples unless NotSync is explicitly set. P/B pictures
            // depend on decoded references; never describe them as random-access points.
            if let attachments=CMSampleBufferGetSampleAttachmentsArray(sample,createIfNecessary:true) {
                let dictionary=unsafeBitCast(CFArrayGetValueAtIndex(attachments,0),to:CFMutableDictionary.self)
                let depends = randomAccess ? kCFBooleanFalse! : kCFBooleanTrue!
                CFDictionarySetValue(dictionary,Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),Unmanaged.passUnretained(depends).toOpaque())
                CFDictionarySetValue(dictionary,Unmanaged.passUnretained(kCMSampleAttachmentKey_DependsOnOthers).toOpaque(),Unmanaged.passUnretained(depends).toOpaque())
            }
            submitted+=1
            // Synchronous callback: decoded frames and reference state stay on the receiver queue.
            var outputError:OSStatus=0
            var gotImage=false
            let status=VTDecompressionSessionDecodeFrame(session,sampleBuffer:sample,flags:[],infoFlagsOut:nil) { [self] status,_,image,_,_ in
                outputError=status
                if status==0,let image {gotImage=true;decoded+=1;needsKeyframe=false;onFrame(image)}
            }
            try check(status,"decode submission");try check(outputError,"decode output")
            if !gotImage {decoderDropped+=1}
        } catch {invalidateReferences();onFailure(error.localizedDescription)}
    }
    private func check(_ status:OSStatus,_ operation:String) throws {
        if status != 0 {throw NSError(domain:"HEVCDecoder",code:Int(status),userInfo:[NSLocalizedDescriptionKey:"\(operation): \(status)"])}
    }
    private func configure() throws {
        guard let vps=parameterSets[32],let sps=parameterSets[33],let pps=parameterSets[34] else {return}
        let status=vps.withUnsafeBytes {v in sps.withUnsafeBytes {s in pps.withUnsafeBytes {p in
            let pointers=[v.bindMemory(to:UInt8.self).baseAddress!,s.bindMemory(to:UInt8.self).baseAddress!,p.bindMemory(to:UInt8.self).baseAddress!]
            return CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator:kCFAllocatorDefault,parameterSetCount:3,parameterSetPointers:pointers,parameterSetSizes:[vps.count,sps.count,pps.count],nalUnitHeaderLength:4,extensions:nil,formatDescriptionOut:&format)
        }}}
        try check(status,"HEVC format")
        guard let format else {return}
        // Explicit decoder selection makes transport/assembly identical in both modes.
        var specification:[CFString:Any]=[kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder:useHardware]
        if useHardware {specification[kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder]=true}
        try check(VTDecompressionSessionCreate(allocator:kCFAllocatorDefault,formatDescription:format,decoderSpecification:specification as CFDictionary,imageBufferAttributes:[kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,outputCallback:nil,decompressionSessionOut:&session),"decoder creation")
        if let session {
            VTSessionSetProperty(session,key:kVTDecompressionPropertyKey_RealTime,value:kCFBooleanTrue)
            var actualHardware:CFTypeRef?
            let status=VTSessionCopyProperty(session,key:kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,allocator:kCFAllocatorDefault,valueOut:&actualHardware)
            if status==0,let enabled=actualHardware as? Bool {
                onConfiguration("HEVC decoder: \(enabled ? "hardware" : "software") (requested \(useHardware ? "hardware" : "software"))")
            } else {onConfiguration("HEVC decoder requested \(useHardware ? "hardware" : "software"); backend query status \(status)")}
        }
    }
}
