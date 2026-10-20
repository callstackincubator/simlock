// simlock-device-capture's source: one physical iPhone's screen, through CoreDevice's media stream.
//
// The steps, in the order the PoC proved them (ADR 0031): find the device, take a usage assertion so
// coredeviced loads its services, build an offer whose HEVC capabilities say "standalone decoder",
// start the stream to a local socket routed to the iPhone's tunnel, receive it as RTP, decode it with
// VideoToolbox. The deadline below is the only clock the start respects; every step shares it, so no
// step adds its own timeout on top of the stream's own first-frame bound.
//
// The shape of these calls is this repo's own PoC (docs/internal/adr/0031); the HEVC capability string
// is idevice's (MIT). See NOTICE.md.
import CoreDevice
import CoreVideo
import Foundation
import Network
import SimlockCapture
import SimlockMediaBridge

/// What CoreDevice's usage assertion needs loaded before it will serve a media stream. DeviceHub takes
/// the same states for its own mirroring; without an assertion of our own the media stream's support
/// query fails on a Mac where DeviceHub is not already holding the device's services open.
let requiredDeviceStates: Set<AssertableDeviceState> = [
    .developerModeEnabledIfRequired,
    .coreDeviceServicesLoaded,
    .extendedDeviceInfoLoaded,
    .remoteServiceDiscoveryTrustedConnectivityAvailable,
    .secureNetworkingAvailable,
]

/// Launch to the first decoded picture. The stream module gives a capture 30 s to write its meta
/// frame, so this has to end inside that — 25 s leaves the encode loop 5 s to produce a picture, and a
/// reason that names the step that ran out of time is worth more to a user than "wrote nothing".
let startDeadlineSeconds: TimeInterval = 25

/// How often the device list is re-read, and the start call and the first picture are re-checked.
private let pollSeconds: TimeInterval = 0.25

/// The whole stop's bound. It is shorter than the daemon's own 2 s grace on purpose: the program that
/// gives up on an unreachable iPhone is the one that ends its stream cleanly, and a close that hangs
/// past the grace is SIGKILLed with the iPhone's stream left up.
private let stopBoundSeconds: TimeInterval = 1.5

/// This program's monotonic clock. A wall-clock jump must not extend or cut a stream's deadline.
func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

/// A CoreDevice call that has to be watched rather than awaited: awaiting its `Task` would let this
/// side's own deadline cancel a call that cannot be taken back, and a `startMediaStream` that completes
/// after its deadline started a stream whose id is the only thing that can stop it.
final class CallBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?

    var settled: Result<Value, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return result
    }

    func complete(with offered: Result<Value, Error>) {
        lock.lock()
        result = offered
        lock.unlock()
    }
}

/// One physical iPhone's media stream, as a `ScreenSource`.
///
/// A class behind one lock rather than an actor: the receive loop runs on its own thread for the life
/// of the stream, and a `stop()` that must be back inside 1.5 s cannot be built on a queue that may be
/// parked in the very CoreDevice call it is waiting for. Every lock use is in a synchronous helper, so
/// no async context ever holds the lock.
final class DeviceScreenSource: ScreenSource, @unchecked Sendable {
    /// The one clock for launch → first decoded picture, shared by every step and by the receive loop.
    let deadline: TimeInterval

    private let lock = NSLock()
    private var stopping = false
    private var byeWanted = false
    private var device: RemoteDevice?
    private var assertion: DeviceUsageAssertion?
    private var streamID: UInt32?
    private var startingCall: CallBox<DeviceMediaStream.StartResponse>?
    private var receiveLoopStarted = false
    private var loopFinished = false
    private var onEnd: ((String?) -> Void)?

    /// Signalled by the receive loop when it ends, whichever way.
    private let loopEnded = DispatchSemaphore(value: 0)

    init() {
        deadline = uptime() + startDeadlineSeconds
    }

    // MARK: - ScreenSource

    func start(
        deviceID: String,
        onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
        onEnd: @escaping @Sendable (_ reason: String?) -> Void
    ) async throws {
        setOnEnd(onEnd)

        do {
            try refuseIfStopping()

            let device = try await findDevice(udid: deviceID)
            try refuseIfStopping()

            let support = try await takeAssertionAndQuerySupport(of: device, deviceID: deviceID)
            try refuseIfStopping()

            let tunnel = try tunnelAddress(of: device, deviceID: deviceID)
            guard let local = simlockBindForTunnel(tunnel) else {
                throw CaptureError("No route to iPhone \(deviceID)'s tunnel on this Mac")
            }
            try refuseIfStopping()

            let (negotiator, options, offer) = try makeOffer(for: device, deviceID: deviceID)
            let response = try await startStream(
                on: device,
                offer: offer,
                options: options,
                support: support,
                localAddress: local,
                deviceID: deviceID
            )
            try refuseIfStopping()

            let remoteSSRC = try applyAnswer(response, with: negotiator, deviceID: deviceID)
            try await beginReceiving(
                remoteSSRC: remoteSSRC,
                answer: response,
                localAddress: local,
                onFrame: onFrame,
                deviceID: deviceID
            )
        } catch {
            // Whatever this source opened is closed again before the reason goes out, so a start that
            // was refused leaves nothing running on the iPhone.
            await closeEverything()
            throw error
        }
    }

    func stop() async {
        if markStopping() { log("stopping the device capture") }
        await closeEverything()
    }

    // MARK: - The steps

    /// The iPhone's entry in CoreDevice's device list, re-read until it shows or the deadline passes.
    /// An iPhone that is plugged in but not yet trusted appears only after a person answers on its
    /// screen, so waiting is the correct behaviour and refusing at once is not.
    private func findDevice(udid: String) async throws -> RemoteDevice {
        let wanted = udid.lowercased()
        while true {
            try refuseIfStopping()
            if let found = CoreDeviceCalls.allDevices().first(where: {
                $0.deviceInfo.udid?.lowercased() == wanted
            }) {
                note(device: found)
                return found
            }
            guard uptime() < deadline else {
                throw CaptureError("iPhone \(udid) is not connected to this Mac")
            }
            try await nap(until: min(deadline, uptime() + pollSeconds))
        }
    }

    /// The step everything else depends on: with no assertion of our own, coredeviced has no reason to
    /// have this device's developer services loaded, and the media stream's support query then fails
    /// with nothing in its message to say why.
    private func takeAssertionAndQuerySupport(
        of device: RemoteDevice,
        deviceID: String
    ) async throws -> DeviceMediaStream.SupportInfoResponse {
        // The two awaits below carry no timeout of their own: the stream module's own 30 s
        // first-frame bound ends a capture that never produces a picture, and whatever coredeviced
        // answers after that finds the program already on its way out.
        let assertion: DeviceUsageAssertion
        do {
            assertion = try await CoreDeviceCalls.acquireAssertion(of: device)
        } catch {
            throw CaptureError("Could not use iPhone \(deviceID): \(error)")
        }
        note(assertion: assertion)
        watchInvalidation(of: assertion, deviceID: deviceID)

        do {
            return try await CoreDeviceCalls.mediaStreamSupport(of: device)
        } catch {
            throw CaptureError("iPhone \(deviceID) does not offer a media stream: \(error)")
        }
    }

    private func tunnelAddress(of device: RemoteDevice, deviceID: String) throws -> String {
        guard let tunnel = device.deviceInfo.tunnelIPAddressString, !tunnel.isEmpty else {
            throw CaptureError("iPhone \(deviceID) has no paired tunnel on this Mac")
        }
        return tunnel
    }

    /// The offer, built in this process by AVConference's own negotiator from CoreDevice's options for
    /// this device, so the answer the iPhone sends back is one this side can apply. The same options go
    /// back into `startMediaStream`. The HEVC feature string and the long-term reference pictures are
    /// this process's own overrides, installed by the bridge before the negotiator exists.
    private func makeOffer(
        for device: RemoteDevice,
        deviceID: String
    ) throws -> (negotiator: NSObject, options: [String: CodableValue], offer: Data) {
        var values = MediaStreamHelper.getNegotiatorOptions(for: device.deviceInfo)
        values[DeviceMediaStream.kAVCMediaStreamOptionClientName] = "CoreDeviceScreenSharing"
        values[DeviceMediaStream.kAVCMediaStreamOptionClientSessionID] = UUID()
        values["avcMediaStreamOptionCallID"] = UUID().uuidString
        guard let negotiator = simlockNegotiator(values, 5) else {
            throw CaptureError("AVConference's media stream negotiator is not available on this Mac")
        }
        guard let offer = simlockOffer(negotiator) as Data? else {
            throw CaptureError("Could not build a media offer for iPhone \(deviceID)")
        }
        // Built one at a time rather than with `compactMapValues`: the stubs leave CoreDevice's own
        // enum cases out, and a `CodableValue` that cannot be built is the answer wanted here.
        var options: [String: CodableValue] = [:]
        for (key, value) in values {
            if let coded = CodableValue(value) { options[key] = coded }
        }
        return (negotiator, options, offer)
    }

    private func startStream(
        on device: RemoteDevice,
        offer: Data,
        options: [String: CodableValue],
        support: DeviceMediaStream.SupportInfoResponse,
        localAddress: String,
        deviceID: String
    ) async throws -> DeviceMediaStream.StartResponse {
        let request = DeviceMediaStream.StartRequest(
            timeout: UInt(max(1, min(15, deadline - uptime()))),
            type: .video,
            direction: .output,
            negotiatorOffer: offer,
            clientSupportedFeatures: support.client.supportedFeatures,
            receiverIP: localAddress,
            receiverPort: simlockReceiverPort(),
            options: options
        )

        let box = CallBox<DeviceMediaStream.StartResponse>()
        note(startingCall: box)
        Task {
            do {
                box.complete(with: .success(try await CoreDeviceCalls.startStream(on: device, request)))
            } catch {
                box.complete(with: .failure(error))
            }
        }

        // Watched with the deadline rather than cancelled: a call that returns after its deadline
        // started a stream on the iPhone, and its answer carries the only id this process will ever
        // have for it.
        while true {
            if let settled = box.settled {
                clearStartingCall()
                switch settled {
                case .success(let response):
                    // why: the id is taken from the answer here rather than in `applyAnswer`, because a
                    // stop that lands the moment this call returns refuses the start before it gets
                    // there — and the refusal's way back stops what it knows the id of, or leaves this
                    // iPhone's stream up for CoreDevice to notice.
                    if let id = UInt32(exactly: response.connection.streamConfig.StreamInputID) {
                        note(streamID: id)
                    }
                    return response
                case .failure(let error):
                    throw CaptureError("iPhone \(deviceID)'s stream did not start: \(error)")
                }
            }
            guard uptime() < deadline else {
                throw CaptureError("No video from iPhone \(deviceID) within \(Int(startDeadlineSeconds)) s")
            }
            try await nap(until: min(deadline, uptime() + pollSeconds))
        }
    }

    /// Applies the iPhone's answer and takes from its configuration what this side needs. The stream's
    /// id is recorded first, so the exit path every refusal below leads to stops the stream this
    /// program just started rather than leaving it up.
    private func applyAnswer(
        _ response: DeviceMediaStream.StartResponse,
        with negotiator: NSObject,
        deviceID: String
    ) throws -> UInt32 {
        guard let streamID = UInt32(exactly: response.connection.streamConfig.StreamInputID) else {
            throw CaptureError("iPhone \(deviceID)'s stream carried no usable id")
        }
        note(streamID: streamID)

        guard let configuration = simlockAnswer(negotiator, response.negotiatorAnswer as Data) else {
            throw CaptureError("iPhone \(deviceID)'s media answer was refused by this Mac")
        }
        guard let suite = configuration["vcMediaStreamSRTPCipherSuite"] as? NSNumber,
              suite.intValue == 0
        else {
            throw CaptureError(
                "iPhone \(deviceID) offered an encrypted media stream, which this program cannot read"
            )
        }
        // The iPhone's own RTP synchronization source, which every RTCP packet is addressed to. Read
        // through `Encodable` rather than as a struct layout — the shape of a private type is the
        // thing a hand-written stub is most likely to have wrong. The encoder asked is the
        // connection, not the whole answer: the configuration is a part of the connection, so it is
        // one level below the answer's own keys.
        guard
            let json = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(response.connection)),
            let object = json as? [String: Any],
            let streamConfiguration = object["streamConfig"] as? [String: Any],
            let remoteSSRC = (streamConfiguration["RemoteSSRC"] as? NSNumber)?.uint32Value
        else {
            throw CaptureError("iPhone \(deviceID)'s stream configuration was not readable")
        }
        return remoteSSRC
    }

    /// Starts the receive loop. The source is running from here on, which is where `start` returns:
    /// the first picture is what the start deadline measures to, and only the loop learns whether one
    /// ever arrives, so the loop is what ends the source when none does.
    private func beginReceiving(
        remoteSSRC: UInt32,
        answer response: DeviceMediaStream.StartResponse,
        localAddress: String,
        onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
        deviceID: String
    ) async throws {
        // The port this program bound for the tunnel route only ever named the address `startMediaStream`
        // was asked to send to, so it is put down now that the answer is in hand. What receives from here
        // is the socket CoreDevice shares for the stream, which is the one the iPhone's sender is the
        // peer of and the only one an RTCP report can be written from.
        simlockReleaseBoundSocket()
        guard let local = IPv6Address(localAddress),
              let remote = IPv6Address(response.connection.sender.ipv6Address)
        else {
            throw CaptureError("iPhone \(deviceID)'s stream endpoints were not readable")
        }
        let adopted: Bool
        do {
            adopted = try NetworkUtils.withSharedSocketDictionary(
                sourceAddress: local,
                port: response.connection.receiver.port,
                remoteAddress: remote,
                remotePort: response.connection.sender.port
            ) { sockets in
                simlockAdopt(sockets)
            }
        } catch {
            throw CaptureError("iPhone \(deviceID)'s stream socket was not shared: \(error)")
        }
        guard adopted else {
            throw CaptureError("iPhone \(deviceID)'s stream shared no socket to receive on")
        }

        let loop = ReceiveLoop(remoteSSRC: remoteSSRC, onFrame: onFrame, source: self)
        markReceiveLoopStarted()
        DispatchQueue(label: "device-capture-receive").async { loop.run(deviceID: deviceID) }
    }

    // MARK: - What the loop and the lifecycle share

    var wantsBye: Bool {
        lock.lock()
        defer { lock.unlock() }
        return byeWanted
    }

    var isStopping: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopping
    }

    /// The loop's own end, reported once: nil for a clean end, else the reason. After the first picture
    /// the source does not end on silence — a still iPhone sends nothing, and an iPhone that goes away
    /// locks or is unplugged, which the driver's own watcher turns into the end of the lease. What ends
    /// the source from here is its socket dying, or the assertion being invalidated.
    func loopStopped(reason: String?) {
        lock.lock()
        let first = !loopFinished
        loopFinished = true
        let report = onEnd
        lock.unlock()
        loopEnded.signal()
        guard first else { return }
        report?(reason)
    }

    // MARK: - The lock's own helpers

    private func setOnEnd(_ handler: @escaping (String?) -> Void) {
        lock.lock()
        onEnd = handler
        lock.unlock()
    }

    private func note(device found: RemoteDevice) {
        lock.lock()
        device = found
        lock.unlock()
    }

    private func note(assertion: DeviceUsageAssertion) {
        lock.lock()
        self.assertion = assertion
        lock.unlock()
    }

    private func note(streamID id: UInt32) {
        lock.lock()
        streamID = id
        lock.unlock()
    }

    private func note(startingCall box: CallBox<DeviceMediaStream.StartResponse>) {
        lock.lock()
        startingCall = box
        lock.unlock()
    }

    private func clearStartingCall() {
        lock.lock()
        startingCall = nil
        lock.unlock()
    }

    private func takeStartingCall() -> CallBox<DeviceMediaStream.StartResponse>? {
        lock.lock()
        defer { lock.unlock() }
        return startingCall
    }

    /// The handles the way back stops and releases, taken off the source as they are read. A `start`
    /// that fails cleans what it opened, and a stop the caller asked for while that start was running
    /// asks for the same way back; whoever takes a handle first is the one that closes it, so the same
    /// assertion is never released and the same stream never stopped twice.
    private func takeTargets() -> (device: RemoteDevice?, assertion: DeviceUsageAssertion?, streamID: UInt32?) {
        lock.lock()
        defer { lock.unlock() }
        let opened = (device, assertion, streamID)
        device = nil
        assertion = nil
        streamID = nil
        return opened
    }

    private func markReceiveLoopStarted() {
        lock.lock()
        receiveLoopStarted = true
        lock.unlock()
    }

    private var ownsReceiveLoop: Bool {
        lock.lock()
        defer { lock.unlock() }
        return receiveLoopStarted && !loopFinished
    }

    private func markStopping() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let first = !stopping
        stopping = true
        byeWanted = true
        return first
    }

    private func refuseIfStopping() throws {
        // why: `StoppedBeforeStart` rather than a reason — a stop is the caller asking for this end,
        // and a program that prints a reason for the stop it was asked for hands a viewer a 503 about
        // a stream nobody failed.
        guard !isStopping else { throw StoppedBeforeStart() }
    }

    // MARK: - The way back

    /// Every exit ends here: this program's own stream stopped by its own id, this program's own
    /// assertion released, the socket closed. Nothing else on the iPhone is touched — DeviceHub's
    /// stream for the same device is not this program's to stop.
    private func closeEverything() async {
        let bound = uptime() + stopBoundSeconds

        // A start that is still in flight is watched for its id, within the same bound. When it does
        // not return in time this program exits without it, like a SIGKILL would; when it does, its
        // stream id goes on the list of things to stop below.
        if let pending = takeStartingCall() {
            while pending.settled == nil, uptime() < bound {
                try? await Task.sleep(nanoseconds: UInt64(pollSeconds * 1_000_000_000))
            }
            if case let .success(response)? = pending.settled,
               let id = UInt32(exactly: response.connection.streamConfig.StreamInputID) {
                note(streamID: id)
            }
            clearStartingCall()
        }

        // why: on a queue of its own rather than a `Task`, because everything below blocks and the
        // CoreDevice call it waits for needs one of the pool's threads to answer — a blocking close
        // on that pool is one thread short of the answer it is waiting for. The bound is what keeps
        // the close the daemon is waiting on from turning into a SIGKILL.
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue(label: "device-capture-close").async {
                self.closeBlockedParts(by: bound)
                continuation.resume()
            }
        }
    }

    /// The blocking half of the way back: the two waits, and the calls that may never be answered.
    private func closeBlockedParts(by bound: TimeInterval) {
        let opened = takeTargets()
        if opened.device != nil || opened.assertion != nil || opened.streamID != nil {
            let cleaned = DispatchSemaphore(value: 0)
            Task.detached {
                if let device = opened.device, let streamID = opened.streamID {
                    do {
                        // why: `stopAll: false` with this program's own id — the only thing on the
                        // iPhone this program is allowed to stop.
                        _ = try await CoreDeviceCalls.stopStream(on: device, id: streamID)
                        log("iPhone stream \(streamID) stopped")
                    } catch {
                        // An iPhone that is already gone cannot answer, which is the same end state as
                        // a stream that was stopped, and the lease is over either way.
                        log("iPhone stream \(streamID) did not stop cleanly: \(error)")
                    }
                }
                opened.assertion?.releaseAssertion()
                cleaned.signal()
            }
            // Bounded by the same deadline: an iPhone that has gone away cannot answer
            // `stopMediaStream`, and a close the daemon is waiting on must not become a SIGKILL.
            if cleaned.wait(timeout: .now() + max(0, bound - uptime())) == .timedOut {
                log("device capture cleanup gave up")
            }
        }
        // Closing the receiver is also what unblocks a read the loop is parked in. Only a source that
        // ever started one has a loop to wait for: a start refused before the socket opened would
        // otherwise spend the whole stop bound waiting for a thread that was never created.
        let waitingForLoop = ownsReceiveLoop
        simlockCloseReceiver()
        if waitingForLoop, loopEnded.wait(timeout: .now() + max(0, bound - uptime())) == .timedOut {
            log("device capture receiver did not stop within \(stopBoundSeconds) s")
        }
    }

    /// coredeviced invalidates the assertion when the connection goes, and that is a fact this source
    /// learns only from here. A release this source asked for itself arrives as a nil error.
    private func watchInvalidation(of assertion: DeviceUsageAssertion, deviceID: String) {
        assertion.registerInvalidationHandler(invokingOnQueue: .main) { [weak self] error in
            guard let self, let error, !self.isStopping else { return }
            self.loopStopped(reason: "iPhone \(deviceID)'s device connection was lost: \(error)")
        }
    }
}

private func nap(until moment: TimeInterval) async throws {
    let seconds = moment - uptime()
    guard seconds > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

// MARK: - The receive loop

/// The loop that owns the socket: read, reorder, decode, hand over, and report back to the iPhone.
///
/// One thread, because its parts have to stay in step with each other — a packet that is reordered,
/// dropped, or turned into a picture has to be seen by the RTCP report and by the key-frame request
/// exactly as the decoder saw it.
private final class ReceiveLoop: @unchecked Sendable {
    private let remoteSSRC: UInt32
    private let onFrame: @Sendable (CVPixelBuffer) -> Void
    private unowned let source: DeviceScreenSource

    private let parser = HEVCRTPReceiver()
    private let decoder = HEVCDecoder()
    /// The last decoded picture, re-emitted while nothing new arrives. The simulator source does the
    /// same for the same reason: a still iPhone sends nothing, and a stream that sends nothing looks
    /// dead from the viewer's side.
    private var lastPicture: CVPixelBuffer?
    private var lastEmitted = uptime()
    private var lastReport = 0.0
    private var lastKeyframeRequest = 0.0
    private var decoded = 0

    init(
        remoteSSRC: UInt32,
        onFrame: @escaping @Sendable (CVPixelBuffer) -> Void,
        source: DeviceScreenSource
    ) {
        self.remoteSSRC = remoteSSRC
        self.onFrame = onFrame
        self.source = source
        parser.onAccessUnit = { [weak self] unit in
            self?.decoder.decode(unit.nals, timestamp: unit.timestamp)
        }
        parser.onLoss = { [weak self] in self?.decoder.invalidate() }
        decoder.onFrame = { [weak self] pixel in self?.emit(pixel) }
        decoder.onFailure = { message in log("HEVC: \(message)") }
        decoder.onConfiguration = { message in log(message) }
    }

    func run(deviceID: String) {
        var timedOut = false
        while true {
            if source.wantsBye {
                _ = simlockSend(parser.report(receiver: remoteSSRC, bye: true))
                break
            }
            if let datagram = simlockReceive(5) {
                parser.receive(datagram as Data)
            }
            // why: the window is flushed and the report written on the clock rather than only when a
            // packet arrives — the two moments a report is worth sending are the two where the iPhone
            // has stopped sending: a picture held in the reorder window with nothing behind it, and a
            // decoder still waiting for its first key frame.
            parser.flushPending()
            let now = uptime()
            if reportIsDue(now: now) { report(now: now) }
            if !keepAlive() { break }
            // The one clock from launch to the first decoded picture, which `start` has already
            // returned under: past it the stream would answer 200 and show nothing, so the source ends
            // and names the step that ran out.
            if decoded == 0, uptime() >= source.deadline {
                timedOut = true
                break
            }
        }
        let reason: String?
        if decoded > 0 || source.isStopping {
            reason = nil
        } else if timedOut {
            reason = "No video from iPhone \(deviceID) within \(Int(startDeadlineSeconds)) s"
        } else {
            reason = "iPhone \(deviceID) sent no video this program could decode"
        }
        source.loopStopped(reason: reason)
    }

    /// Re-emits the last picture at least every 200 ms, and says whether the loop should go on.
    private func keepAlive() -> Bool {
        let now = uptime()
        if now - lastEmitted >= 0.2, let lastPicture {
            lastEmitted = now
            onFrame(lastPicture)
        }
        return !source.isStopping
    }

    /// Whether a report is worth sending now: once a second, or sooner while the decoder still has no
    /// picture to start from, because a key-frame request is at most twice a second (F20). Nothing is
    /// reported before the iPhone's own synchronization source is known — a report speaks about
    /// packets received from a source, and a picture loss indication has no one to ask.
    private func reportIsDue(now: TimeInterval) -> Bool {
        guard parser.source != nil else { return false }
        return now - lastReport >= 1 || (decoder.needsKeyframe && now - lastKeyframeRequest >= 0.5)
    }

    /// One receiver report, and a picture loss indication while the decoder still has no picture to
    /// start from. That request is at most twice a second: an iPhone that cannot serve the key frame
    /// is not helped by being asked harder.
    private func report(now: TimeInterval) {
        let requesting = decoder.needsKeyframe && now - lastKeyframeRequest >= 0.5
        guard simlockSend(parser.report(receiver: remoteSSRC, requestKeyframe: requesting)) else {
            return
        }
        lastReport = now
        if requesting { lastKeyframeRequest = now }
    }

    /// Counts the pictures this loop has handed over, on the loop's own thread: the decode callback is
    /// synchronous, so this and the first-picture check in `run` cannot disagree.
    private func emit(_ pixel: CVPixelBuffer) {
        decoded += 1
        lastPicture = pixel
        lastEmitted = uptime()
        onFrame(pixel)
    }
}

// MARK: - CoreDevice

/// Every CoreDevice call, on the main thread under a run loop of this program's own. The framework's
/// client is a main-thread API in places and a command-line program has no UI run loop to hand it over,
/// so a call that wants one gets a hop to the main queue and its answer resumed from there.
enum CoreDeviceCalls {
    private static let manager = DeviceManager(serviceConnection: CoreDeviceService.sharedConnection)

    static func allDevices() -> [RemoteDevice] {
        if Thread.isMainThread { return manager.allDevices() }
        return DispatchQueue.main.sync { manager.allDevices() }
    }

    static func acquireAssertion(of device: RemoteDevice) async throws -> DeviceUsageAssertion {
        try await onMain {
            try await device.acquireDeviceUsageAssertion(
                withReason: "simlock screen stream",
                requirements: UsageAssertionRequirements(
                    deviceStates: requiredDeviceStates,
                    capabilities: []
                )
            )
        }
    }

    static func mediaStreamSupport(
        of device: RemoteDevice
    ) async throws -> DeviceMediaStream.SupportInfoResponse {
        try await onMain { try await device.mediaStreamSupportInfo }
    }

    static func startStream(
        on device: RemoteDevice,
        _ request: DeviceMediaStream.StartRequest
    ) async throws -> DeviceMediaStream.StartResponse {
        try await onMain { try await device.startMediaStream(with: request) }
    }

    static func stopStream(
        on device: RemoteDevice,
        id: UInt32
    ) async throws -> DeviceMediaStream.StopResponse {
        try await onMain {
            try await device.stopMediaStream(
                with: DeviceMediaStream.StopRequest(stopAll: false, identifiers: [id])
            )
        }
    }
}

/// Runs an async CoreDevice call from the main thread and resumes wherever its answer arrives.
private func onMain<Value>(
    _ work: @escaping () async throws -> Value
) async throws -> Value {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Value, Error>) in
        DispatchQueue.main.async {
            Task {
                do {
                    continuation.resume(returning: try await work())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
