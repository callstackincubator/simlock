import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Turns captured frames into an H.264 bitstream, one frame per call.
///
/// What comes back is AVCC: each NAL unit preceded by its four-byte length, which is
/// what a decoder consuming a container wants. Annex-B start codes — the `00 00 00 01`
/// spelling in a raw `.264` file — are never produced here.
///
/// Everything is public VideoToolbox. Private API ends at the framebuffer; by the time a
/// frame reaches this file it is an ordinary `CVPixelBuffer`.
actor H264Encoder {
    /// One encoded frame, ready to go on the wire.
    struct Encoded {
        let kind: Kind
        /// Length-prefixed AVCC NAL bytes, with no Annex-B start codes anywhere in them.
        let avcc: Data
        /// An `avcC` record (ISO/IEC 14496-15 §5.2.4.1) carrying the SPS and PPS.
        ///
        /// Non-nil on exactly one frame per session — the first IDR — because that is the
        /// only moment a viewer needs it. Nothing else carries the parameter sets, and a
        /// decoder cannot start from an IDR without them, so a stream that never emits this
        /// decodes to nothing. The frame it accompanies is the first one out of the session,
        /// which is why the record always reaches a viewer ahead of the video it describes;
        /// a rebuilt session emits a fresh pair, since new dimensions mean new sets.
        let description: Data?

        enum Kind { case keyframe, delta }
    }

    /// Submission is one-way and completion is a callback, so every encode waits on the
    /// callback. `UnownedSerialExecutor` pins the actor to this queue, which is what makes
    /// that wait cheap: the actor hops back onto the queue the callback already arrived on
    /// instead of landing on a cooperative pool thread and then hopping again.
    /// Unowned is sound because the queue is a stored property of the actor.
    private let queue = DispatchSerialQueue(label: "h264-encoder", qos: .userInteractive)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private var session: VTCompressionSession?
    /// The size `session` was created for.
    private var frameSize: Dimensions?
    private let fps: Int32
    private var bitrate: Int
    /// Whether the current session has already handed out its parameter sets.
    private var descriptionSent = false
    /// Encodes so far, never reset — see `encode`.
    private var framesSent: Int64 = 0

    init(fps: Int = 60, bitrate: Int = 6_000_000) {
        self.fps = Int32(fps)
        self.bitrate = bitrate
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    /// Encode one frame, or return nil if nothing came of it.
    ///
    /// A real-time session sheds load by discarding a frame rather than falling behind,
    /// and that is a normal outcome of streaming: it comes back as nil, not as a thrown
    /// error. Skipping a frame costs the stream one missing delta, which the next
    /// P-frame covers; throwing would end the session over something the encoder does on
    /// purpose.
    ///
    /// - Important: `source` must not be a buffer whose pixels can still change.
    ///   VideoToolbox keeps encoding after this call returns, and its contract is that the
    ///   client "should not modify the pixel data after making this call" — the session
    ///   retains the buffer rather than promising a copy of it, so the pixels have to stay
    ///   put. The capture path therefore deep-copies the live framebuffer before it gets
    ///   here.
    func encode(_ source: CVPixelBuffer, forceKeyframe: Bool = false) async throws -> Encoded? {
        // Retrying whenever there is no session is deliberate: if creating one fails, the
        // next frame gets another attempt rather than a session that stays missing for the
        // rest of the stream.
        let size = source.dimensions
        if session == nil || size != frameSize {
            rebuildSession(for: size)
        }
        guard let session else {
            throw Errors.couldNotCreateSession
        }

        // A frame counter divided by the nominal frame rate, not the wall clock: VideoToolbox
        // requires strictly increasing timestamps, and this satisfies that however erratically
        // frames actually arrive. The counter is never reset — not even when a rotation
        // rebuilds the session — so a size change can never move a timestamp backwards.
        framesSent += 1
        let presentationTime = CMTime(value: framesSent, timescale: fps)

        let frameProperties: NSDictionary? = forceKeyframe
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue!]
            : nil

        let outcome: (status: OSStatus, flags: VTEncodeInfoFlags, sample: CMSampleBuffer?) =
            await withCheckedContinuation { continuation in
                let status = VTCompressionSessionEncodeFrame(
                    session,
                    imageBuffer: source,
                    presentationTimeStamp: presentationTime,
                    duration: .invalid,
                    frameProperties: frameProperties,
                    infoFlagsOut: nil
                ) { @Sendable status, flags, sample in
                    continuation.resume(returning: (status, flags, sample))
                }
                // A submission that fails outright never reaches the callback, so this is the
                // only place that answer can be reported.
                if status != noErr {
                    continuation.resume(returning: (status, [], nil))
                }
            }

        if outcome.status == noErr, outcome.flags.contains(.frameDropped) { return nil }
        guard outcome.status == noErr else { throw Errors.encodingFailed(outcome.status) }
        guard let sample = outcome.sample else { throw Errors.missingSampleBuffer }
        return try encoded(from: sample)
    }

    /// Tear the session down early. Frames already submitted are not flushed — the last
    /// couple of frames of a stream may never leave the encoder, which a live viewer
    /// never notices.
    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
            self.session = nil
        }
    }

    // MARK: - Session

    /// Replace the session with one sized for `size`, and allow the parameter sets to be
    /// emitted again: a new size means new SPS and PPS, and a viewer that already took the
    /// old ones needs the new pair.
    private func rebuildSession(for size: Dimensions) {
        invalidateSession()
        guard let session = createSession(for: size) else { return }
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
        self.frameSize = size
        self.descriptionSent = false
    }

    private func invalidateSession() {
        if let session { VTCompressionSessionInvalidate(session) }
        self.session = nil
        self.frameSize = nil
    }

    /// A session configured for a live view: as little delay as the encoder will give up,
    /// and nothing in the bitstream that makes a decoder sit on frames.
    ///
    /// Returns nil if the encoder could not be created, and reports failure the same way
    /// for a session that came back without one, because VideoToolbox does both. A failed
    /// rebuild leaves no session, so the next frame attempts it again.
    private func createSession(for size: Dimensions) -> VTCompressionSession? {
        let width = Int32(size.width)
        let height = Int32(size.height)
        // Asking for low-latency rate control is the part that actually buys the latency
        // back. It selects the real-time encoder pipeline *and* writes a bitstream whose
        // sequence parameters tell the decoder it may hold few reference pictures —
        // `max_dec_frame_buffering`. That second half is the one that matters, and it is
        // invisible here: without it a decoder fills a large decoded picture buffer before
        // emitting anything, which measures out as roughly 300ms of delay on the viewer
        // even though this encoder emits no B-frames at all. See
        // VTCompressionProperties.h, "Ultra-low-latency conferencing and cloud gaming".
        let lowLatency: CFDictionary = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue!,
        ] as CFDictionary

        // The specification is a request, not a guarantee: an encoder that does not
        // implement low-latency rate control fails the creation call. Falling back to a
        // session with no specification keeps the stream working, merely further behind, so
        // a machine that rejects it gets a stream rather than an error.
        var candidate: VTCompressionSession?
        var status = Self.create(width: width, height: height, specification: lowLatency, &candidate)
        if status != noErr || candidate == nil {
            candidate = nil
            status = Self.create(width: width, height: height, specification: nil, &candidate)
        }
        guard status == noErr, let candidate else { return nil }

        let properties: [(key: CFString, value: Any)] = [
            // The encode is driven by frames arriving in real time, not by a file to chew
            // through, so the encoder is told to spend for cadence rather than for quality.
            (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!),
            // High profile; the level is the encoder's call, since it is bounded by the
            // resolution and rate we end up with and not by anything we know up front.
            (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel),
            // No B-frames, so decode order and display order are the same order: a
            // reordering decoder has to hold frames to put them back, and that is latency
            // we are here to remove.
            (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!),
            (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate)),
            (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps)),
            // An IDR is several times the size of a delta, so spacing them out keeps the
            // average cost of a frame down where the motion is. A viewer arriving between
            // two of them does not wait for the next one — the first frame of every session
            // is forced to be an IDR.
            (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: Int(fps) * 5)),
        ]
        for property in properties {
            VTSessionSetProperty(candidate, key: property.key, value: property.value as CFTypeRef)
        }
        return candidate
    }

    private static func create(
        width: Int32,
        height: Int32,
        specification: CFDictionary?,
        _ sessionOut: inout VTCompressionSession?
    ) -> OSStatus {
        VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification,
            imageBufferAttributes: nil,
            compressedDataAllocator: kCFAllocatorDefault,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &sessionOut
        )
    }

    // MARK: - Sample buffers

    /// The frame's bytes, and its parameter sets if this is the first IDR of the session.
    private func encoded(from sample: CMSampleBuffer) throws -> Encoded {
        let isKeyframe = !isNotSync(sample)
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            throw Errors.invalidSampleBuffer
        }
        var byteCount = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &byteCount,
            dataPointerOut: &pointer
        ) == noErr, let pointer
        else {
            throw Errors.invalidSampleBuffer
        }
        // VideoToolbox hands H.264 back in AVCC already — the block *is* a run of
        // four-byte-length/NAL pairs, so the bytes go out as they stand.
        let avcc = Data(bytes: pointer, count: byteCount)

        var description: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            if let record = Self.avcC(from: format), !descriptionSent {
                descriptionSent = true
                description = record
            }
        }
        return Encoded(kind: isKeyframe ? .keyframe : .delta, avcc: avcc, description: description)
    }

    /// Whether a sample is marked as *not* a random-access point, which is how VideoToolbox
    /// says "delta frame".
    ///
    /// It is the absence of the key that means sync — the encoder omits the attachment on a
    /// keyframe rather than setting it false — hence the presence test rather than a value
    /// comparison.
    private func isNotSync(_ sample: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0,
              let entry = CFArrayGetValueAtIndex(attachments, 0)
        else { return false }
        // A CFArray hands back an untyped pointer; the attachment array's only documented
        // contents are CFDictionary per sample, so this reads the one entry there is.
        let attachment = unsafeBitCast(entry, to: CFDictionary.self)
        return CFDictionaryContainsKey(
            attachment,
            Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque()
        )
    }

    /// The AVC decoder configuration record for a format — the SPS and PPS in the one blob
    /// a viewer needs before it can decode anything.
    ///
    /// The layout is fixed by ISO/IEC 14496-15 §5.2.4.1; the constants below are that
    /// record's fields, in order. The first three bytes of the SPS after its header byte
    /// *are* the profile, compatibility and level fields, which is why they are read out of
    /// the SPS rather than asked of the encoder — one source of truth, no chance of the
    /// record disagreeing with the stream.
    private static func avcC(from format: CMFormatDescription) -> Data? {
        // Only the SPS and PPS at indices 0 and 1 go into the record, so the count and the
        // NAL header length are not asked for; the size is, and it has to be long enough to
        // carry the profile/compat/level bytes read out of it below.
        var spsPointer: UnsafePointer<UInt8>?
        var spsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: &spsPointer,
            parameterSetSizeOut: &spsSize,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
        ) == noErr, let spsPointer, spsSize >= 4 else { return nil }

        var ppsPointer: UnsafePointer<UInt8>?
        var ppsSize = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPointer,
            parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: nil
        ) == noErr, let ppsPointer else { return nil }

        let sps = UnsafeBufferPointer(start: spsPointer, count: spsSize)
        let pps = UnsafeBufferPointer(start: ppsPointer, count: ppsSize)

        var record = Data()
        record.append(0x01) // configurationVersion
        record.append(sps[1]) // profileIdc
        record.append(sps[2]) // profileCompatibility
        record.append(sps[3]) // levelIdc
        record.append(0xFF) // 0b111111: reserved, plus lengthSizeMinusOne == 3 — the
                            // four-byte NAL lengths this encoder's output is prefixed with
        record.append(0xE1) // 0b11100001: reserved, plus one SPS
        record.append(uint16BigEndian: spsSize)
        record.append(contentsOf: sps)
        record.append(0x01) // exactly one PPS, which is what we are holding
        record.append(uint16BigEndian: ppsSize)
        record.append(contentsOf: pps)
        return record
    }

    enum Errors: Error {
        case couldNotCreateSession
        case encodingFailed(OSStatus)
        case missingSampleBuffer
        case invalidSampleBuffer
    }
}

private extension Data {
    /// Appends `value` as two big-endian bytes — the length field's width in an `avcC`
    /// record's parameter-set entries.
    mutating func append(uint16BigEndian value: Int) {
        append(UInt8((value >> 8) & 0xFF))
        append(UInt8(value & 0xFF))
    }
}
