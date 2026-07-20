import AppKit
import Darwin
import Foundation
import WebKit

private struct OverlayCommand: Codable {
    let type: String
    let version: Int
    let state: String?
    let activeCount: Int?
    let failedCount: Int?
    let reviewCount: Int?
    let waitingCount: Int?
    let clickThrough: Bool?
    let enabled: Bool?
    let showActiveCount: Bool?
    let size: Double?
    let htmlPath: String?
    let label: String?
    let notifications: [OverlayNotification]?
}

private struct OverlayNotification: Codable {
    let id: String
    let persistent: Bool
    let sessionId: String
    let state: String
    let statusText: String
    let title: String
}

private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class UDPListener {
    private let fileDescriptor: Int32
    private let source: DispatchSourceRead
    var onMessage: ((Data) -> Void)?

    init?(port: UInt16) {
        let descriptor = Darwin.socket(AF_INET, SOCK_DGRAM, 0)
        guard descriptor >= 0 else { return nil }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(
                    descriptor,
                    $0,
                    socklen_t(MemoryLayout<sockaddr_in>.size)
                )
            }
        }
        guard result == 0 else {
            Darwin.close(descriptor)
            return nil
        }

        fileDescriptor = descriptor
        source = DispatchSource.makeReadSource(
            fileDescriptor: descriptor,
            queue: DispatchQueue.global(qos: .userInitiated)
        )
        source.setEventHandler { [weak self] in
            self?.receive()
        }
        source.resume()
    }

    deinit {
        source.cancel()
        Darwin.close(fileDescriptor)
    }

    private func receive() {
        var buffer = [UInt8](repeating: 0, count: 65_535)
        let count = buffer.withUnsafeMutableBytes {
            Darwin.recvfrom(
                fileDescriptor,
                $0.baseAddress,
                $0.count,
                0,
                nil,
                nil
            )
        }
        guard count > 0 else { return }
        onMessage?(Data(buffer.prefix(Int(count))))
    }
}

private protocol PetBridgeDelegate: AnyObject {
    func beginDrag()
    func openNotification(id: String)
}

private final class PetBridge: NSObject, WKScriptMessageHandler {
    weak var delegate: PetBridgeDelegate?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "pet",
              let payload = message.body as? [String: Any],
              let type = payload["type"] as? String else {
            return
        }
        if type == "dragStart" {
            delegate?.beginDrag()
        } else if
            type == "notificationClick",
            let id = payload["id"] as? String
        {
            delegate?.openNotification(id: id)
        }
    }
}

private final class PetWindowController: NSObject, WKNavigationDelegate, PetBridgeDelegate {
    private let panel: PetPanel
    private let webView: WKWebView
    private let bridge = PetBridge()
    private var pageReady = false
    private var lastCommand: OverlayCommand?
    private var dragStartMouse = NSPoint.zero
    private var dragStartOrigin = NSPoint.zero
    private var localDragMonitor: Any?
    private var globalDragMonitor: Any?

    init(htmlPath: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(bridge, name: "pet")

        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 340, height: 148),
            configuration: configuration
        )
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        panel = PetPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 148),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()

        bridge.delegate = self
        webView.navigationDelegate = self
        panel.contentView = webView
        panel.acceptsMouseMovedEvents = true
        panel.backgroundColor = .clear
        panel.collectionBehavior = [
            .canJoinAllSpaces,
            .fullScreenAuxiliary,
            .stationary
        ]
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isOpaque = false
        panel.level = .floating
        panel.title = "Kiro Pet"

        let fileURL = URL(fileURLWithPath: htmlPath)
        webView.loadFileURL(
            fileURL,
            allowingReadAccessTo: fileURL.deletingLastPathComponent()
        )
        restorePosition()
        panel.orderFrontRegardless()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        if let command = lastCommand {
            sendToPage(command)
        }
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        fputs("Kiro Pet navigation failed: \(error.localizedDescription)\n", stderr)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        fputs("Kiro Pet page load failed: \(error.localizedDescription)\n", stderr)
    }

    func apply(_ command: OverlayCommand) {
        lastCommand = command

        if let size = command.size {
            resize(
                to: CGFloat(min(max(size, 88), 240)),
                notificationCount: command.notifications?.count ?? 0
            )
        }
        if let clickThrough = command.clickThrough {
            panel.ignoresMouseEvents = clickThrough
        }
        if let label = command.label {
            panel.title = label
        }
        if command.enabled == false {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
        }
        if pageReady {
            sendToPage(command)
        }
    }

    func resetPosition() {
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let visibleFrame = screen?.visibleFrame else { return }
        let origin = NSPoint(
            x: visibleFrame.maxX - panel.frame.width - 24,
            y: visibleFrame.minY + 24
        )
        panel.setFrameOrigin(origin)
        savePosition()
    }

    func beginDrag() {
        guard !panel.ignoresMouseEvents else { return }
        endDrag()
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = panel.frame.origin

        localDragMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            self?.handleDragEvent(event)
            return event
        }
        globalDragMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            self?.handleDragEvent(event)
        }
    }

    func openNotification(id: String) {
        guard
            let notification = lastCommand?.notifications?.first(
                where: { $0.id == id }
            )
        else { return }
        var components = URLComponents()
        components.scheme = "kiro"
        components.host = "TalhaKhalil.kiro-pet"
        components.path = "/open"
        components.queryItems = [
            URLQueryItem(name: "sessionId", value: notification.sessionId),
            URLQueryItem(name: "title", value: notification.title),
            URLQueryItem(name: "notificationId", value: notification.id)
        ]
        if let url = components.url {
            NSWorkspace.shared.open(url)
        }
    }

    private func handleDragEvent(_ event: NSEvent) {
        if event.type == .leftMouseUp {
            endDrag()
            return
        }
        guard event.type == .leftMouseDragged else { return }
        let mouse = NSEvent.mouseLocation
        panel.setFrameOrigin(
            NSPoint(
                x: dragStartOrigin.x + mouse.x - dragStartMouse.x,
                y: dragStartOrigin.y + mouse.y - dragStartMouse.y
            )
        )
    }

    private func endDrag() {
        if let monitor = localDragMonitor {
            NSEvent.removeMonitor(monitor)
            localDragMonitor = nil
        }
        if let monitor = globalDragMonitor {
            NSEvent.removeMonitor(monitor)
            globalDragMonitor = nil
        }
        savePosition()
    }

    private func resize(to size: CGFloat, notificationCount: Int) {
        let width = max(340, size)
        let height = size + CGFloat(notificationCount * 84)
        guard
            abs(panel.frame.width - width) > 0.5 ||
            abs(panel.frame.height - height) > 0.5
        else { return }
        let anchoredMaxX = panel.frame.maxX
        let anchoredMinY = panel.frame.minY
        panel.setContentSize(NSSize(width: width, height: height))
        panel.setFrameOrigin(
            NSPoint(
                x: anchoredMaxX - width,
                y: anchoredMinY
            )
        )
        keepOnScreen()
    }

    private func sendToPage(_ command: OverlayCommand) {
        guard
            let data = try? JSONEncoder().encode(command),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        webView.evaluateJavaScript("window.kiroPet?.setState(\(json));")
    }

    private func restorePosition() {
        let defaults = UserDefaults.standard
        if
            defaults.object(forKey: "petPositionX") != nil,
            defaults.object(forKey: "petPositionY") != nil
        {
            panel.setFrameOrigin(
                NSPoint(
                    x: defaults.double(forKey: "petPositionX"),
                    y: defaults.double(forKey: "petPositionY")
                )
            )
            keepOnScreen()
        } else {
            resetPosition()
        }
    }

    private func keepOnScreen() {
        guard !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(panel.frame) }) else {
            return
        }
        resetPosition()
    }

    private func savePosition() {
        let defaults = UserDefaults.standard
        defaults.set(Double(panel.frame.origin.x), forKey: "petPositionX")
        defaults.set(Double(panel.frame.origin.y), forKey: "petPositionY")
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let htmlPath: String
    private let heartbeatPath: String
    private let port: UInt16
    private var listener: UDPListener?
    private var windowController: PetWindowController?
    private var heartbeatTimer: Timer?
    private var lastMessageAt = Date()

    init(htmlPath: String, heartbeatPath: String, port: UInt16) {
        self.htmlPath = htmlPath
        self.heartbeatPath = heartbeatPath
        self.port = port
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let listener = UDPListener(port: port) else {
            NSApp.terminate(nil)
            return
        }
        self.listener = listener
        windowController = PetWindowController(htmlPath: htmlPath)
        listener.onMessage = { [weak self] data in
            DispatchQueue.main.async {
                self?.handle(data)
            }
        }

        writeHeartbeat()
        heartbeatTimer = Timer.scheduledTimer(
            withTimeInterval: 2,
            repeats: true
        ) { [weak self] _ in
            self?.tick()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        heartbeatTimer?.invalidate()
        try? FileManager.default.removeItem(atPath: heartbeatPath)
    }

    private func handle(_ data: Data) {
        guard let command = try? JSONDecoder().decode(OverlayCommand.self, from: data) else {
            return
        }
        lastMessageAt = Date()
        switch command.type {
        case "state":
            windowController?.apply(command)
        case "reset-position":
            windowController?.resetPosition()
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func tick() {
        writeHeartbeat()
        if Date().timeIntervalSince(lastMessageAt) > 12 {
            NSApp.terminate(nil)
        }
    }

    private func writeHeartbeat() {
        let contents = String(Date().timeIntervalSince1970)
        try? contents.write(
            toFile: heartbeatPath,
            atomically: true,
            encoding: .utf8
        )
    }
}

guard CommandLine.arguments.count >= 4 else {
    fputs("Usage: kiro-pet-overlay <html> <heartbeat> <port>\n", stderr)
    exit(2)
}

let htmlPath = CommandLine.arguments[1]
let heartbeatPath = CommandLine.arguments[2]
guard let port = UInt16(CommandLine.arguments[3]) else {
    fputs("Invalid UDP port\n", stderr)
    exit(2)
}

let application = NSApplication.shared
private let delegate = AppDelegate(
    htmlPath: htmlPath,
    heartbeatPath: heartbeatPath,
    port: port
)
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
