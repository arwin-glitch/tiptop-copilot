import Foundation

/// The decisions the iPhone shell makes about what the live site may do,
/// written with Foundation alone so CI can compile and run them on the Mac
/// runner itself (ios-app/tests/main.swift), with no simulator.
enum ShellPolicy {

    // MARK: - Bridge

    /// The Capacitor plugins a page may call. Push alerts (PushNotifications),
    /// the sign-in return link and app lifecycle (App), the status bar style
    /// (SystemBars) and console mirroring (Console).
    ///
    /// Capacitor registers CapacitorHttp, CapacitorCookies and WebView in every
    /// app whatever the config says. None is used here, and each would let a
    /// script on the page step around the browser's own rules: native requests
    /// that ignore CORS and the CSP's connect-src, cookie writes from script,
    /// and a different server path. So the shell drops calls to them.
    static let allowedPlugins: Set<String> = ["App", "PushNotifications", "SystemBars", "Console"]

    /// Whether a message posted to Capacitor's "bridge" handler may reach
    /// Capacitor. It must come from the live site's own top-level page (not a
    /// frame inside it, nor the bundled offline page) and have one of the
    /// shapes in Capacitor 8.5.3's native-bridge.js: `{type: "message",
    /// pluginId, methodName, callbackId, options}` for a call to an allowed
    /// plugin, or `{type: "js.error", error}` for a startup error, which
    /// Capacitor only logs. Anything else, Cordova calls included, is dropped.
    static func allowsBridgeMessage(_ body: Any, fromMainFrame: Bool, originURL: URL?, serverURL: URL) -> Bool {
        guard fromMainFrame, let originURL, isAppAddress(originURL, serverURL: serverURL) else {
            return false
        }
        guard let message = body as? [String: Any], let type = message["type"] as? String else {
            return false
        }
        switch type {
        case "message":
            guard let plugin = message["pluginId"] as? String else { return false }
            return allowedPlugins.contains(plugin)
        case "js.error":
            return true
        default:
            return false
        }
    }

    /// The answer the shell gives, in place of Capacitor, to the page's
    /// synchronous prompt() channel, or nil for an ordinary prompt() that
    /// should show as usual.
    ///
    /// native-bridge.js asks over prompt() whether native HTTP and cookies are
    /// on, and Capacitor 8.5.3 answers the cookie reads and writes on that
    /// channel even when CapacitorCookies is off. Both are off here, so the
    /// shell says so and ignores the reads and writes, which the page never
    /// sends while cookies are off.
    static func syncBridgeAnswer(toPrompt prompt: String) -> String? {
        guard let data = prompt.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any],
              let type = payload["type"] as? String else {
            return nil
        }
        switch type {
        case "CapacitorCookies.isEnabled", "CapacitorHttp":
            return "false"
        case "CapacitorCookies.get", "CapacitorCookies.set":
            return ""
        default:
            return nil
        }
    }

    // MARK: - Navigation

    /// Whether a failed load should be replaced by the bundled offline page.
    ///
    /// Only a network failure should. Capacitor 8.5.3 shows the page for every
    /// error, which hides a working page in three everyday cases: a navigation
    /// that was cancelled (-999, when a newer one replaced it or Capacitor
    /// handed the address to Safari), a load WebKit stopped because it became
    /// a download or a hand-off (WebKitErrorDomain 102, "frame load
    /// interrupted"), and media a plug-in plays itself (WebKitErrorDomain 204).
    static func showsOfflinePage(for error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSURLErrorDomain && error.code != NSURLErrorCancelled
    }

    /// Whether an address is a page of the live site, so it opens in the app
    /// rather than in Safari. Same scheme, host and port as the server URL, and
    /// a path under its path. Compares parts rather than text, so an address
    /// such as https://copilot.tiptop.vc.example.com/ never passes.
    static func isAppAddress(_ url: URL, serverURL: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == serverURL.scheme?.lowercased(),
              let host = url.host?.lowercased(), host == serverURL.host?.lowercased(),
              url.port == serverURL.port,
              url.user == nil, url.password == nil else {
            return false
        }
        let path = url.path.isEmpty ? "/" : url.path
        let root = serverURL.path.isEmpty ? "/" : serverURL.path
        return path.hasPrefix(root)
    }

    // MARK: - Downloads

    /// Whether a page response is a file to save rather than a page to show:
    /// the server sent it as an attachment, or WebKit cannot show its type.
    /// A 204 or 205 has nothing to save, and WebKit leaves the page as it is.
    static func isDownload(contentDisposition: String?, canShowMIMEType: Bool, statusCode: Int?) -> Bool {
        if statusCode == 204 || statusCode == 205 { return false }
        if !canShowMIMEType { return true }
        guard let disposition = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased() else {
            return false
        }
        return disposition.hasPrefix("attachment")
    }

    /// A file name that is safe to create in the shell's own temporary folder:
    /// the suggested name without any folder part or control characters, no
    /// longer than 120 characters, and "download" when nothing usable is left.
    static func downloadFileName(_ suggested: String) -> String {
        let lastPart = suggested.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var printable = String.UnicodeScalarView()
        for scalar in lastPart.unicodeScalars where !CharacterSet.controlCharacters.contains(scalar) {
            printable.append(scalar)
        }
        var name = String(printable).replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.count > 120 {
            // Keeps a short extension, so the share sheet still knows the type.
            let ext = (name as NSString).pathExtension
            if !ext.isEmpty && ext.count <= 10 {
                let stem = (name as NSString).deletingPathExtension
                name = String(stem.prefix(120 - ext.count - 1)) + "." + ext
            } else {
                name = String(name.prefix(120))
            }
        }
        return name.isEmpty ? "download" : name
    }
}

/// Short lines in the device log, prefixed so CI's simulator check can find
/// them. They name events only, never an address or a file name, which could
/// be someone's data.
enum ShellLog {
    static func note(_ message: String) {
        NSLog("TipTopShell: %@", message)
    }
}
