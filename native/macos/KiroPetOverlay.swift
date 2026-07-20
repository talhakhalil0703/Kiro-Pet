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
    let callbackPort: Int?
    let sourceId: String?
    let workspaceUri: String?
}

private struct OverlayNotification: Codable {
    let id: String
    let persistent: Bool
    let sessionId: String
    let state: String
    let statusText: String
    let title: String
    let callbackPort: Int?
    let sourceId: String?
    let workspaceUri: String?
}

private struct NotificationClick: Codable {
    let type: String
    let version: Int
    let notificationId: String
    let sessionId: String
    let sourceId: String
    let title: String
}

private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class UDPListener {
    private let fileDescriptor: Int32
    private let source: DispatchSourceRead
    var onMessage: ((Data, UInt16) -> Void)?

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

    func send(_ data: Data, to port: UInt16) {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        data.withUnsafeBytes { bytes in
            withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    _ = Darwin.sendto(
                        fileDescriptor,
                        bytes.baseAddress,
                        bytes.count,
                        0,
                        $0,
                        socklen_t(MemoryLayout<sockaddr_in>.size)
                    )
                }
            }
        }
    }

    private func receive() {
        var buffer = [UInt8](repeating: 0, count: 65_535)
        var sender = sockaddr_in()
        var senderLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let count = buffer.withUnsafeMutableBytes { bytes in
            withUnsafeMutablePointer(to: &sender) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.recvfrom(
                        fileDescriptor,
                        bytes.baseAddress,
                        bytes.count,
                        0,
                        $0,
                        &senderLength
                    )
                }
            }
        }
        guard count > 0 else { return }
        onMessage?(
            Data(buffer.prefix(Int(count))),
            UInt16(bigEndian: sender.sin_port)
        )
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
    var onNotificationClick: ((OverlayNotification) -> Void)?

    init(htmlPath: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(bridge, name: "pet")

        webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 340, height: 112),
            configuration: configuration
        )
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]

        panel = PetPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 112),
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
        onNotificationClick?(notification)
    }

    func openLegacyNotification(_ notification: OverlayNotification) {
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

private struct TimedSource {
    let command: OverlayCommand
    let receivedAt: Date
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private static let sourceStaleSeconds: TimeInterval = 6
    private let htmlPath: String
    private let heartbeatPath: String
    private let port: UInt16
    private var listener: UDPListener?
    private var windowController: PetWindowController?
    private var heartbeatTimer: Timer?
    private var lastMessageAt = Date()
    private var sources: [String: TimedSource] = [:]
    private var hasSeenVersionTwo = false

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
        let controller = PetWindowController(htmlPath: htmlPath)
        controller.onNotificationClick = { [weak self] notification in
            self?.open(notification)
        }
        windowController = controller
        listener.onMessage = { [weak self] data, senderPort in
            DispatchQueue.main.async {
                self?.handle(data, senderPort: senderPort)
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

    private func handle(_ data: Data, senderPort: UInt16) {
        guard let command = try? JSONDecoder().decode(OverlayCommand.self, from: data) else {
            return
        }
        switch command.type {
        case "state":
            if updateSource(command, senderPort: senderPort) {
                lastMessageAt = Date()
            }
        case "reset-position":
            lastMessageAt = Date()
            windowController?.resetPosition()
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    private func updateSource(
        _ command: OverlayCommand,
        senderPort: UInt16
    ) -> Bool {
        if
            command.version >= 2,
            let sourceId = command.sourceId,
            !sourceId.isEmpty,
            command.callbackPort != nil
        {
            if !hasSeenVersionTwo {
                hasSeenVersionTwo = true
                sources = sources.filter { !$0.key.hasPrefix("legacy:") }
            }
            sources[sourceId] = TimedSource(
                command: command,
                receivedAt: Date()
            )
        } else if !hasSeenVersionTwo {
            sources["legacy:\(senderPort)"] = TimedSource(
                command: command,
                receivedAt: Date()
            )
        } else {
            return false
        }
        applyCombinedState()
        return true
    }

    private func applyCombinedState() {
        guard let combined = combineSources(Array(sources.values)) else {
            return
        }
        windowController?.apply(combined)
    }

    private func open(_ notification: OverlayNotification) {
        if
            let portValue = notification.callbackPort,
            let callbackPort = UInt16(exactly: portValue),
            callbackPort > 0,
            let sourceId = notification.sourceId,
            let data = try? JSONEncoder().encode(
                NotificationClick(
                    type: "notification-click",
                    version: 2,
                    notificationId: notification.id,
                    sessionId: notification.sessionId,
                    sourceId: sourceId,
                    title: notification.title
                )
            )
        {
            listener?.send(data, to: callbackPort)
            focusWorkspace(notification.workspaceUri)
        } else {
            windowController?.openLegacyNotification(notification)
        }
    }

    private func focusWorkspace(_ workspaceUri: String?) {
        guard
            let workspaceUri,
            let source = URLComponents(string: workspaceUri)
        else { return }

        var target = URLComponents()
        target.scheme = "kiro"
        if source.scheme == "file" {
            target.host = "file"
            target.path = source.path
        } else if
            source.scheme == "vscode-remote",
            let authority = source.host
        {
            target.host = "vscode-remote"
            target.path = "/\(authority)\(source.path)"
        } else {
            return
        }
        guard let url = target.url else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            NSWorkspace.shared.open(url)
        }
    }

    private func tick() {
        writeHeartbeat()
        let staleBefore = Date().addingTimeInterval(
            -Self.sourceStaleSeconds
        )
        let sourceCount = sources.count
        sources = sources.filter { $0.value.receivedAt >= staleBefore }
        if sources.count != sourceCount {
            applyCombinedState()
        }
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

private func combineSources(_ sources: [TimedSource]) -> OverlayCommand? {
    guard
        let latest = sources.max(
            by: { $0.receivedAt < $1.receivedAt }
        )
    else { return nil }

    let commands = sources.map(\.command)
    let state = commands
        .compactMap(\.state)
        .min(by: { statePriority($0) < statePriority($1) }) ?? "idle"
    let activeCount = aggregateCount(commands, \.activeCount)
    let failedCount = aggregateCount(commands, \.failedCount)
    let reviewCount = aggregateCount(commands, \.reviewCount)
    let waitingCount = aggregateCount(commands, \.waitingCount)

    var notificationsById: [String: OverlayNotification] = [:]
    for source in sources.sorted(by: { $0.receivedAt < $1.receivedAt }) {
        for notification in source.command.notifications ?? []
            where notification.state != "running"
        {
            notificationsById[notification.id] = OverlayNotification(
                id: notification.id,
                persistent: notification.persistent,
                sessionId: notification.sessionId,
                state: notification.state,
                statusText: notification.statusText,
                title: notification.title,
                callbackPort: source.command.callbackPort,
                sourceId: source.command.sourceId,
                workspaceUri: source.command.workspaceUri
            )
        }
    }
    let notifications = notificationsById.values.sorted {
        let left = statePriority($0.state)
        let right = statePriority($1.state)
        if left != right {
            return left < right
        }
        return $0.title.localizedCaseInsensitiveCompare($1.title)
            == .orderedAscending
    }

    let latestCommand = latest.command
    return OverlayCommand(
        type: "state",
        version: 2,
        state: state,
        activeCount: activeCount,
        failedCount: failedCount,
        reviewCount: reviewCount,
        waitingCount: waitingCount,
        clickThrough: latestCommand.clickThrough,
        enabled: latestCommand.enabled,
        showActiveCount: latestCommand.showActiveCount,
        size: latestCommand.size,
        htmlPath: latestCommand.htmlPath,
        label: combinedLabel(
            state: state,
            activeCount: activeCount,
            failedCount: failedCount,
            waitingCount: waitingCount
        ),
        notifications: notifications,
        callbackPort: nil,
        sourceId: nil,
        workspaceUri: nil
    )
}

private func aggregateCount(
    _ commands: [OverlayCommand],
    _ keyPath: KeyPath<OverlayCommand, Int?>
) -> Int {
    let counts = commands.map { $0[keyPath: keyPath] ?? 0 }
    if commands.allSatisfy({ $0.version >= 2 }) {
        return counts.reduce(0, +)
    }
    return counts.max() ?? 0
}

private func statePriority(_ state: String) -> Int {
    switch state {
    case "waiting":
        return 0
    case "failed":
        return 1
    case "running":
        return 2
    case "review":
        return 3
    default:
        return 4
    }
}

private func combinedLabel(
    state: String,
    activeCount: Int,
    failedCount: Int,
    waitingCount: Int
) -> String {
    switch state {
    case "running":
        return activeCount > 1
            ? "\(activeCount) chats working"
            : "Kiro is working"
    case "waiting":
        return waitingCount > 1
            ? "\(waitingCount) chats need you"
            : "Kiro needs you"
    case "review":
        return "Ready to review"
    case "failed":
        return failedCount > 1
            ? "\(failedCount) chats hit errors"
            : "A chat hit an error"
    default:
        return "Kiro Pet is idle"
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
