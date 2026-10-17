// DeviceStreamPoC — a third-party macOS app that mirrors a physical iPhone and sends touches to it.
//
// Findings behind this design (see README.md):
//   • Device discovery, display info and HID input come from Xcode's private CoreDevice.framework
//     (client of coredeviced / the remotepairingd tunnel). Both work without special entitlements.
//   • The video path DeviceHub uses (CoreDeviceMediaStreamSupport → AVConference) is gated by the
//     restricted entitlement com.apple.videoconference.allow-conferencing, so it is kept here only
//     as an optional experiment ("Try CoreDevice media stream").
//   • Default video uses a custom CoreDevice RTP receiver and local VideoToolbox decoding.
//   • The USB fallback uses the public QuickTime path: CoreMediaIO's
//     kCMIOHardwarePropertyAllowScreenCaptureDevices exposes a USB-connected iPhone as an
//     AVCaptureDevice (muxed audio+video), rendered with AVCaptureVideoPreviewLayer.
//   • Clicks on the preview are converted to normalized (0…1) coordinates and sent through
//     CoreDevice's remote HID digitizer (com.apple.coredevice.feature.remote.hid.digitizer).
//
// The private frameworks ship no Swift interfaces, so ../Stubs holds hand-written .swiftinterface
// files that mirror their ABI (they are built with library evolution → stable dispatch thunks).

import AppKit
import AVFoundation
import CoreMediaIO
import QuartzCore
import CoreDevice
import CoreDeviceProtocols
import CoreDeviceTypes
import CoreDeviceMediaStreamSupport

// MARK: - Logging

let logFileHandle: FileHandle? = {
    let path = ProcessInfo.processInfo.environment["LOGFILE"] ?? Bundle.main.bundleURL
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("work/demo-app.log").path
    FileManager.default.createFile(atPath: path, contents: nil)
    return FileHandle(forWritingAtPath: path)
}()

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(message)"
    print(line)
    fflush(stdout)
    if let logFileHandle { logFileHandle.seekToEndOfFile(); logFileHandle.write((line + "\n").data(using: .utf8)!) }
    DispatchQueue.main.async { AppDelegate.shared?.appendLog(message) }
}

// MARK: - Touch injection (CoreDevice remote HID digitizer)

@MainActor
final class TouchInjector {
    private var digitizer: (any HIDDigitizer)?
    private(set) var isReady = false

    func connect(device: RemoteDevice) async {
        let member = CapabilityStaticMember<DigitizerHIDCapability>()
        guard device.supports(member) else {
            log("HID: device does not report the remote HID digitizer capability")
            return
        }
        do {
            let impl = try await device.getImplementation(for: member)
            digitizer = impl
            isReady = true
            log("HID: digitizer implementation ready (\(type(of: impl)))")
        } catch {
            log("HID: failed to get digitizer implementation: \(error)")
        }
    }

    /// `point` is normalized: (0,0) top-left of the device screen, (1,1) bottom-right.
    func send(_ eventType: DigitizerEventType, at point: CGPoint, edge: DigitizerEdge = .none) {
        guard let digitizer else { return }
        let p = DigitizerPoint(x: Double(min(max(point.x, 0), 1)), y: Double(min(max(point.y, 0), 1)))
        do {
            try digitizer.send(pointOne: p, pointTwo: nil, eventType: eventType, edge: edge, target: .mainScreen)
            if eventType == .end { digitizer.sendBarrier() }
        } catch {
            log("HID: send failed: \(error)")
        }
    }

    func disconnect() {
        digitizer = nil
        isReady = false
    }
}

// MARK: - QuickTime-style screen capture (CoreMediaIO + AVFoundation)

@MainActor
final class ScreenCapture: NSObject {
    private var session: AVCaptureSession?
    private(set) var previewLayer: AVCaptureVideoPreviewLayer?
    private(set) var device: AVCaptureDevice?
    private var connectObserver: NSObjectProtocol?

    static func enableScreenCaptureDevices() {
        var address = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var allow: UInt32 = 1
        let status = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
                                               UInt32(MemoryLayout<UInt32>.size), &allow)
        log("CMIO: kCMIOHardwarePropertyAllowScreenCaptureDevices = 1 (status \(status))")
    }

    /// iOS screen devices show up as external muxed devices whose uniqueID is the device UDID.
    static func captureDevices() -> [AVCaptureDevice] {
        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified)
        return discovery.devices.filter { $0.hasMediaType(.muxed) || $0.hasMediaType(.video) }
    }

    static func findDevice(udid: String?, name: String?) -> AVCaptureDevice? {
        let devices = captureDevices()
        for d in devices { log("CMIO: capture device '\(d.localizedName)' uniqueID=\(d.uniqueID) model=\(d.modelID) muxed=\(d.hasMediaType(.muxed))") }
        if let udid, let d = devices.first(where: { $0.uniqueID.caseInsensitiveCompare(udid) == .orderedSame }) { return d }
        if let name, let d = devices.first(where: { $0.localizedName == name }) { return d }
        return devices.first(where: { $0.modelID.localizedCaseInsensitiveContains("iOS") })
    }

    func start(udid: String?, name: String?, into hostLayer: CALayer, completion: @escaping (Result<Void, Error>) -> Void) {
        ScreenCapture.enableScreenCaptureDevices()
        // The screen device is published asynchronously after the property flips; wait for it.
        if let device = ScreenCapture.findDevice(udid: udid, name: name) {
            attach(device: device, into: hostLayer, completion: completion)
            return
        }
        log("CMIO: iPhone screen capture device not published yet, waiting for AVCaptureDeviceWasConnected…")
        connectObserver = NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.session == nil, let device = ScreenCapture.findDevice(udid: udid, name: name) else { return }
                self.attach(device: device, into: hostLayer, completion: completion)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, self.session == nil else { return }
            completion(.failure(NSError(domain: "DeviceStreamPoC", code: 1, userInfo: [NSLocalizedDescriptionKey: "No iPhone screen-capture device appeared. Is the iPhone connected over USB and unlocked (Trust This Computer)?"])))
        }
    }

    private func attach(device: AVCaptureDevice, into hostLayer: CALayer, completion: @escaping (Result<Void, Error>) -> Void) {
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver); self.connectObserver = nil }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                guard granted else {
                    completion(.failure(NSError(domain: "DeviceStreamPoC", code: 2, userInfo: [NSLocalizedDescriptionKey: "Camera access denied (needed for iOS screen capture devices)."])))
                    return
                }
                do {
                    let session = AVCaptureSession()
                    session.beginConfiguration()
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else { throw NSError(domain: "DeviceStreamPoC", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot add capture input"]) }
                    session.addInput(input)
                    session.commitConfiguration()
                    let preview = AVCaptureVideoPreviewLayer(session: session)
                    preview.videoGravity = .resizeAspect
                    preview.backgroundColor = NSColor.black.cgColor
                    preview.frame = hostLayer.bounds
                    hostLayer.addSublayer(preview)
                    self.previewLayer = preview
                    self.session = session
                    self.device = device
                    session.startRunning()
                    let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                    log("CMIO: capturing '\(device.localizedName)' \(dims.width)x\(dims.height) via AVCaptureSession")
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
            }
        }
    }

    /// Size of the incoming video frames (pixels), used to map clicks to normalized device coordinates.
    var videoSize: CGSize? {
        guard let device else { return nil }
        let d = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        guard d.width > 0, d.height > 0 else { return nil }
        return CGSize(width: Int(d.width), height: Int(d.height))
    }

    func layout(in hostLayer: CALayer) {
        previewLayer?.frame = hostLayer.bounds
    }

    func stop() {
        if let connectObserver { NotificationCenter.default.removeObserver(connectObserver); self.connectObserver = nil }
        session?.stopRunning()
        previewLayer?.removeFromSuperlayer()
        previewLayer = nil
        session = nil
        device = nil
    }
}

// MARK: - Optional experiment: DeviceHub's own video path (needs com.apple.videoconference.allow-conferencing)

@MainActor
final class MediaStreamExperiment {
    private var session: MediaStreamSession?
    private var stream: (any VideoStream)?
    private var task: Task<Void, Never>?

    func start(device: RemoteDevice, layer: CALayer, onStateChange: @escaping (String) -> Void) {
        let session = MediaStreamSession(clientSessionID: UUID())
        self.session = session
        task = Task { [weak self] in
            do {
                let configuration: VideoStreamConfiguration = .receiveMirroredPrimary(layer: layer, timeout: 30)
                log("MediaStream: makeVideoStream(.receiveMirroredPrimary)")
                let stream = try await session.makeVideoStream(withConfiguration: configuration, fromRemoteDevice: device)
                await MainActor.run { self?.stream = stream }
                let events = try await stream.activate()
                onStateChange("CoreDevice media stream active — waiting for first frame…")
                for try await event in events {
                    switch event {
                    case .receivedFirstFrame: log("MediaStream: receivedFirstFrame"); onStateChange("CoreDevice media stream: streaming")
                    case .remoteVideoAttributesChanged(let a): log("MediaStream: attributes ratio=\(a.ratio) rect=\(a.contentsRect)")
                    case .receivedLastDecodedFrame(let d): log("MediaStream: last decoded frame \(d.count) bytes")
                    @unknown default: break
                    }
                }
                onStateChange("CoreDevice media stream ended")
            } catch {
                log("MediaStream: error \(error)")
                onStateChange("CoreDevice media stream failed: \(error.localizedDescription)")
            }
        }
    }

    func stop() {
        task?.cancel(); task = nil
        let s = stream; stream = nil
        Task { await s?.invalidate() }
    }
}

// MARK: - Device screen view (hosts the preview layer, forwards mouse input as touches)

final class DeviceScreenView: NSView {
    /// Maps a point in this view's coordinates to normalized device coordinates (0…1, y down).
    var mapPoint: (CGPoint) -> CGPoint? = { _ in nil }
    var onTouch: (DigitizerEventType, CGPoint, DigitizerEdge) -> Void = { _, _, _ in }
    var onLayout: (CALayer) -> Void = { _ in }
    private var tracking = false
    private var gestureEdge: DigitizerEdge = .none

    /// Starting a drag within 3% of a screen edge marks it as an edge gesture (home, Control Center, back…).
    private func edge(for p: CGPoint) -> DigitizerEdge {
        if p.y >= 0.97 { return .bottom }
        if p.y <= 0.03 { return .top }
        if p.x <= 0.03 { return .left }
        if p.x >= 0.97 { return .right }
        return .none
    }
    private var panOrigin: CGPoint?      // view-space origin of a scroll-wheel pan
    private var panOffset = CGPoint.zero // accumulated scroll delta in view points

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor.black.cgColor
        layer?.masksToBounds = true
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        if let layer { onLayout(layer) }
    }

    func normalizedPoint(forViewPoint p: CGPoint) -> CGPoint? {
        guard let n = mapPoint(p), n.x >= 0, n.x <= 1, n.y >= 0, n.y <= 1 else { return nil }
        return n
    }
    private func normalizedPoint(for event: NSEvent) -> CGPoint? {
        normalizedPoint(forViewPoint: convert(event.locationInWindow, from: nil))
    }

    // Click / drag → tap / pan.
    override func mouseDown(with event: NSEvent) {
        guard let p = normalizedPoint(for: event) else { return }
        tracking = true
        gestureEdge = edge(for: p)
        onTouch(.start, p, gestureEdge)
    }
    override func mouseDragged(with event: NSEvent) {
        guard tracking, let p = normalizedPoint(for: event) else { return }
        onTouch(.position, p, gestureEdge)
    }
    override func mouseUp(with event: NSEvent) {
        guard tracking else { return }
        tracking = false
        onTouch(.end, normalizedPoint(for: event) ?? CGPoint(x: 0.5, y: 0.5), gestureEdge)
    }

    // Two-finger scroll → synthesized one-finger pan starting under the cursor.
    override func scrollWheel(with event: NSEvent) {
        let local = convert(event.locationInWindow, from: nil)
        switch event.phase {
        case .began:
            panOrigin = local; panOffset = .zero
            if let p = normalizedPoint(forViewPoint: local) { gestureEdge = edge(for: p); onTouch(.start, p, gestureEdge) }
        case .changed:
            guard let origin = panOrigin else { return }
            // Natural scrolling: content follows the fingers, like a touch drag.
            panOffset.x += event.scrollingDeltaX
            panOffset.y -= event.scrollingDeltaY   // AppKit y is up; scrollingDeltaY > 0 means fingers moved down… content down
            if let p = normalizedPoint(forViewPoint: CGPoint(x: origin.x + panOffset.x, y: origin.y + panOffset.y)) { onTouch(.position, p, gestureEdge) }
        case .ended, .cancelled:
            guard let origin = panOrigin else { return }
            let end = CGPoint(x: origin.x + panOffset.x, y: origin.y + panOffset.y)
            onTouch(.end, normalizedPoint(forViewPoint: end) ?? normalizedPoint(forViewPoint: origin) ?? CGPoint(x: 0.5, y: 0.5), gestureEdge)
            panOrigin = nil
        default:
            // Non-gesture wheel (mouse): one short flick per event.
            guard panOrigin == nil, let start = normalizedPoint(forViewPoint: local) else { return }
            let end = CGPoint(x: local.x + event.scrollingDeltaX * 4, y: local.y - event.scrollingDeltaY * 4)
            onTouch(.start, start, .none)
            onTouch(.position, normalizedPoint(forViewPoint: end) ?? start, .none)
            onTouch(.end, normalizedPoint(forViewPoint: end) ?? start, .none)
        }
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var shared: AppDelegate?

    private var window: NSWindow!
    private var devicePopup: NSPopUpButton!
    private var startButton: NSButton!
    private var stopButton: NSButton!
    private var experimentButton: NSButton!
    private var statusLabel: NSTextField!
    private var logView: NSTextView!
    private var screenView: DeviceScreenView!
    private var aspectConstraint: NSLayoutConstraint?

    private var manager: DeviceManager!
    private var devices: [RemoteDevice] = []
    private let capture = ScreenCapture()
    private let networkMirror = NetworkMirror()
    private var usbButton: NSButton!
    private var softwareDecoderButton: NSButton!
    private let touch = TouchInjector()
    private let experiment = MediaStreamExperiment()

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        buildUI()
        connectToCoreDevice()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { stopAll() }

    // MARK: UI

    private func buildUI() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "DeviceStreamPoC — USB / Wi-Fi mirror"
        window.center()

        let content = NSView()
        window.contentView = content

        devicePopup = NSPopUpButton(frame: .zero, pullsDown: false)
        startButton = NSButton(title: "Start mirror", target: self, action: #selector(startTapped))
        startButton.keyEquivalent = "\r"
        stopButton = NSButton(title: "Stop", target: self, action: #selector(stopTapped))
        stopButton.isEnabled = false
        experimentButton = NSButton(title: "Try CoreDevice media stream", target: self, action: #selector(experimentTapped))
        usbButton = NSButton(title: "USB fallback", target: self, action: #selector(usbTapped))
        softwareDecoderButton = NSButton(checkboxWithTitle: "Software HEVC", target: nil, action: nil)
        softwareDecoderButton.state = .on
        softwareDecoderButton.toolTip = "Use the software decoder. Change while stopped to compare with hardware decoding."
        let refreshButton = NSButton(title: "Refresh devices", target: self, action: #selector(refreshTapped))

        statusLabel = NSTextField(labelWithString: "Connecting to CoreDevice service…")
        statusLabel.lineBreakMode = .byTruncatingTail

        screenView = DeviceScreenView(frame: .zero)
        screenView.mapPoint = { [weak self] viewPoint in
            guard let self else {return nil}
            if self.networkMirror.layer != nil {return self.networkMirror.normalizedPoint(viewPoint,in:self.screenView.bounds)}
            guard let preview = self.capture.previewLayer, let host = self.screenView.layer else {return nil}
            // View coords == root-layer coords for a layer-backed (non-flipped) NSView; the preview layer
            // knows its aspect-fit video rect and converts to capture-device space (0…1, origin top-left).
            let layerPoint = host.convert(viewPoint, to: preview)
            let p = preview.captureDevicePointConverted(fromLayerPoint: layerPoint)
            // On macOS the conversion keeps the layer's y-up convention; the digitizer wants y-down.
            return CGPoint(x: p.x, y: 1 - p.y)
        }
        screenView.onLayout = { [weak self] layer in self?.capture.layout(in: layer); self?.networkMirror.layout(in: layer) }
        screenView.onTouch = { [weak self] type, point, edge in
            guard let self else { return }
            self.touch.send(type, at: point, edge: edge)
            if type != .position {
                log(String(format: "HID: %@ at (%.3f, %.3f)%@", type == .start ? "touch down" : "touch up", point.x, point.y, edge == .none ? "" : " [edge gesture]"))
            }
        }

        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        logView = NSTextView()
        logView.isEditable = false
        logView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        logView.autoresizingMask = [.width]
        logView.isVerticallyResizable = true
        logView.textContainer?.widthTracksTextView = true
        scroll.documentView = logView

        let toolbar = NSStackView(views: [devicePopup, refreshButton, startButton, stopButton, usbButton, softwareDecoderButton])
        toolbar.orientation = .horizontal
        toolbar.spacing = 8

        for v in [toolbar, statusLabel, screenView, scroll] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(v)
        }

        NSLayoutConstraint.activate([
            toolbar.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
            toolbar.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            statusLabel.topAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: 8),
            statusLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            screenView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            screenView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            screenView.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            screenView.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, multiplier: 0.6),
            scroll.topAnchor.constraint(equalTo: screenView.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: screenView.trailingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
            scroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 280),
        ])
        setAspect(9.0 / 19.5)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setAspect(_ widthOverHeight: CGFloat) {
        aspectConstraint?.isActive = false
        aspectConstraint = screenView.widthAnchor.constraint(equalTo: screenView.heightAnchor, multiplier: widthOverHeight)
        aspectConstraint?.priority = .defaultHigh
        aspectConstraint?.isActive = true
    }

    func appendLog(_ line: String) {
        guard let logView else { return }
        logView.textStorage?.append(NSAttributedString(string: line + "\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.textColor,
        ]))
        logView.scrollToEndOfDocument(nil)
    }

    private func setStatus(_ text: String) { statusLabel.stringValue = text }

    // MARK: CoreDevice

    private func connectToCoreDevice() {
        manager = DeviceManager(serviceConnection: CoreDeviceService.sharedConnection)
        log("CoreDevice: DeviceManager created from CoreDeviceService.sharedConnection")
        refreshDevices()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            self.refreshDevices()
            // AUTOSTART=<substring of device name> starts the mirror without clicking (used for testing).
            if let wanted = ProcessInfo.processInfo.environment["AUTOSTART"],
               let index = self.devices.firstIndex(where: { ($0.deviceInfo.name ?? "").localizedCaseInsensitiveContains(wanted) }) {
                self.devicePopup.selectItem(at: index)
                self.startTapped()
            }
        }
    }

    private func refreshDevices() {
        devices = manager.allDevices()
        devicePopup.removeAllItems()
        for device in devices {
            let info = device.deviceInfo
            devicePopup.addItem(withTitle: "\(info.name ?? device.description) — \(info.marketingName ?? info.productType ?? "") [\(info.transportType?.description ?? "?")]")
        }
        if devices.isEmpty {
            devicePopup.addItem(withTitle: "No devices")
            setStatus("No devices reported by CoreDevice yet (pair the device in Xcode first).")
        } else {
            setStatus("\(devices.count) device(s). Pick one and press Start mirror.")
        }
        log("CoreDevice: allDevices() -> \(devices.count)")
        for device in devices {
            let info = device.deviceInfo
            log("  • \(info.name ?? "?") udid=\(info.udid ?? "?") type=\(info.deviceType?.description ?? "?") transport=\(info.transportType?.description ?? "?")")
        }
    }

    private var selectedDevice: RemoteDevice? {
        let index = devicePopup.indexOfSelectedItem
        return index >= 0 && index < devices.count ? devices[index] : nil
    }

    @objc private func refreshTapped() { refreshDevices() }

    @objc private func startTapped() {
        guard startButton.isEnabled, let device = selectedDevice, let layer = screenView.layer else {return}
        startButton.isEnabled=false;usbButton.isEnabled=false;devicePopup.isEnabled=false;stopButton.isEnabled=true
        setStatus("Starting USB / Wi-Fi mirror…")
        softwareDecoderButton.isEnabled=false
        networkMirror.start(device:device,into:layer,useHardware:softwareDecoderButton.state == .off,onPrepared:{ [weak self] in
            guard let self else {return}
            await self.touch.connect(device:device)
        },onState:{ [weak self] state in
            guard let self else {return}
            self.setStatus(state)
            if let size=self.networkMirror.videoSize {self.setAspect(size.width/size.height)}
        },onFinished:{ [weak self] in
            guard let self else {return}
            self.startButton.isEnabled=true;self.usbButton.isEnabled=true;self.devicePopup.isEnabled=true;self.stopButton.isEnabled=false
            self.touch.disconnect()
            self.softwareDecoderButton.isEnabled=true
        })
    }

    @objc private func usbTapped() {
        guard let device = selectedDevice, let layer = screenView.layer else { return }
        startButton.isEnabled = false
        usbButton.isEnabled = false
        devicePopup.isEnabled = false
        stopButton.isEnabled = true
        let info = device.deviceInfo
        setStatus("Starting screen capture for \(info.name ?? "device")…")

        // 1. Video: QuickTime-style CoreMediaIO screen capture device (USB).
        capture.start(udid: info.udid, name: info.name, into: layer) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                if let size = self.capture.videoSize { self.setAspect(size.width / size.height) }
                self.setStatus("Mirroring \(info.name ?? "device") — click or drag on the video to touch the device.")
                if let auto = ProcessInfo.processInfo.environment["AUTOTAP"] {
                    // AUTOTAP=x,y (normalized) sends one tap after the video is up (used for testing).
                    let isView = auto.hasPrefix("view:")
                    let parts = auto.replacingOccurrences(of: "view:", with: "").split(separator: ",").compactMap { Double($0) }
                    if parts.count == 2 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                            var p = CGPoint(x: parts[0], y: parts[1])
                            if isView {
                                let b = self.screenView.bounds
                                let vp = CGPoint(x: b.width * parts[0], y: b.height * parts[1])
                                guard let mapped = self.screenView.normalizedPoint(forViewPoint: vp) else { log("HID: AUTOTAP view point \(vp) is outside the video"); return }
                                log(String(format: "HID: AUTOTAP view (%.0f, %.0f) of %.0fx%.0f -> device (%.3f, %.3f)", vp.x, vp.y, b.width, b.height, mapped.x, mapped.y))
                                p = mapped
                            }
                            self.touch.send(.start, at: p)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                                self.touch.send(.end, at: p)
                                log(String(format: "HID: AUTOTAP sent at (%.3f, %.3f)", p.x, p.y))
                            }
                        }
                    }
                }
            case .failure(let error):
                self.setStatus("Video: \(error.localizedDescription)")
                log("CMIO: \(error)")
            }
        }

        // 2. Input: CoreDevice remote HID digitizer (works over USB and Wi‑Fi).
        Task { await touch.connect(device: device) }
    }

    @objc private func stopTapped() {
        let wasNetwork = networkMirror.layer != nil
        stopAll()
        startButton.isEnabled = !wasNetwork
        usbButton.isEnabled = !wasNetwork
        devicePopup.isEnabled = !wasNetwork
        stopButton.isEnabled = false
        setStatus("Stopped")
    }

    @objc private func experimentTapped() {
        guard let device = selectedDevice, let layer = screenView.layer else { return }
        experiment.start(device: device, layer: layer) { [weak self] state in
            Task { @MainActor in self?.setStatus(state) }
        }
    }

    private func stopAll() {
        networkMirror.stop()
        capture.stop()
        touch.disconnect()
        experiment.stop()
    }
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
