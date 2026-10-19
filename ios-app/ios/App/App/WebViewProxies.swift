import Foundation
import WebKit

// Stand-ins that sit between the web view and Capacitor's own delegate
// (WebViewDelegationHandler in @capacitor/ios 8.5.3). Each passes every call
// Capacitor handles straight through, except the few the live site needs
// handled differently inside an iPhone app. Foundation and WebKit only, so CI
// compiles them on the Mac runner too and checks them without a simulator.
//
// Every delegate method Capacitor 8.5.3 implements is implemented here, and
// DelegateCoverage reports any it does not, so a later Capacitor that adds
// one cannot slip past these stand-ins unnoticed (the simulator check fails).

/// The web view's navigation delegate.
///
/// - Never swaps a working page for the offline page: only a network failure
///   reaches Capacitor's error handling (ShellPolicy.showsOfflinePage).
/// - Saves files instead of failing on them: an attachment, a type WebKit
///   cannot show, or an `<a download>` link (exports, the deal memo, inbox
///   attachments, blob: saves) becomes a WKDownload, and `onDownloadFinished`
///   gets the file to share.
/// - Clears Capacitor's plugin listeners only when a new page actually
///   replaces the old one. Capacitor clears them as soon as any navigation
///   starts, so one that ends as a download, or is handed to Safari after a
///   redirect, would leave the page running with its push and link listeners
///   gone until the next reload.
final class NavigationGuard: NSObject, WKNavigationDelegate, WKDownloadDelegate {
    private let original: WKNavigationDelegate
    var onDownloadFinished: ((URL) -> Void)?
    var onDownloadFailed: (() -> Void)?

    private var resetDue = false
    private var loggedLiveLoad = false
    /// Downloads in flight, held here until they finish or fail (the web view
    /// does not keep them), and the file each one writes once it is chosen.
    private var downloads: Set<WKDownload> = []
    private var files: [WKDownload: URL] = [:]

    init(original: WKNavigationDelegate) {
        self.original = original
    }

    /// The folder downloads are written to, one subfolder per file so two
    /// files with the same name never collide. Inside the app's own temporary
    /// directory, which the system may empty at any time.
    static var downloadsFolder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Downloads", isDirectory: true)
    }

    /// Removes files left from earlier launches.
    static func clearDownloads() {
        try? FileManager.default.removeItem(at: downloadsFolder)
    }

    // MARK: Policy

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // An <a download> link, including the blob: link the web app's
        // export button saves through. Capacitor would send it to Safari,
        // which has neither the file nor the session.
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if original.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler) == nil {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = navigationResponse.response as? HTTPURLResponse
        if navigationResponse.isForMainFrame,
           ShellPolicy.isDownload(
               contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition"),
               canShowMIMEType: navigationResponse.canShowMIMEType,
               statusCode: http?.statusCode
           ) {
            decisionHandler(.download)
            return
        }
        if original.webView?(webView, decidePolicyFor: navigationResponse, decisionHandler: decisionHandler) == nil {
            decisionHandler(.allow)
        }
    }

    // MARK: Lifecycle

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // Capacitor resets the bridge here; that waits for didCommit, below.
        resetDue = true
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if resetDue {
            resetDue = false
            // Capacitor's handler does nothing in this method but reset the
            // bridge, which is exactly what is due now that the page changed.
            original.webView?(webView, didStartProvisionalNavigation: navigation)
        }
        original.webView?(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.scheme == "https" {
            if !loggedLiveLoad {
                loggedLiveLoad = true
                ShellLog.note("loaded the live site")
            }
        } else {
            ShellLog.note("loaded the offline page")
        }
        original.webView?(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard ShellPolicy.showsOfflinePage(for: error) else {
            ShellLog.note("kept the page after \(Self.describe(error))")
            return
        }
        original.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard ShellPolicy.showsOfflinePage(for: error) else {
            ShellLog.note("kept the page after \(Self.describe(error))")
            return
        }
        original.webView?(webView, didFail: navigation, withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if original.webViewWebContentProcessDidTerminate?(webView) == nil {
            webView.reload()
        }
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if original.webView?(webView, didReceive: challenge, completionHandler: completionHandler) == nil {
            // WebKit's own answer when no delegate handles the challenge.
            completionHandler(.rejectProtectionSpace, nil)
        }
    }

    // MARK: Downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        adopt(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        adopt(download)
    }

    private func adopt(_ download: WKDownload) {
        download.delegate = self
        downloads.insert(download)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = Self.downloadsFolder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            ShellLog.note("could not make a folder for a download")
            downloads.remove(download)
            completionHandler(nil)
            onDownloadFailed?()
            return
        }
        let file = folder.appendingPathComponent(ShellPolicy.downloadFileName(suggestedFilename), isDirectory: false)
        files[download] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloads.remove(download)
        guard let file = files.removeValue(forKey: download) else { return }
        ShellLog.note("saved a download")
        onDownloadFinished?(file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.remove(download)
        if let file = files.removeValue(forKey: download) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        let error = error as NSError
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled {
            ShellLog.note("a download was cancelled")
            return
        }
        ShellLog.note("a download failed: \(Self.describe(error))")
        onDownloadFailed?()
    }

    /// An error's domain and code, which say what happened without naming
    /// the address it happened to.
    static func describe(_ error: Error) -> String {
        let error = error as NSError
        return "\(error.domain) \(error.code)"
    }
}

/// The web view's UI delegate.
///
/// - Keeps the live site's own new-window links (target=_blank, window.open)
///   in the app. Capacitor sends every new-window request to Safari, which
///   would open Copilot there signed out. Other sites still go to Safari or
///   their own app, through Capacitor.
/// - Answers native-bridge.js's prompt() channel itself (see
///   ShellPolicy.syncBridgeAnswer).
/// - Refuses camera, microphone and motion access to web pages. Capacitor
///   grants them to any page; Copilot never asks, so a page that does is not
///   Copilot's own code. Photos for file uploads come from the system picker,
///   which this does not touch.
final class UIDelegateGuard: NSObject, WKUIDelegate {
    private let original: WKUIDelegate
    private let serverURL: URL

    init(original: WKUIDelegate, serverURL: URL) {
        self.original = original
        self.serverURL = serverURL
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ShellPolicy.isAppAddress(url, serverURL: serverURL) {
            ShellLog.note("opened a new-window link in place")
            webView.load(navigationAction.request)
            return nil
        }
        if let made = original.webView?(webView, createWebViewWith: configuration, for: navigationAction, windowFeatures: windowFeatures) {
            return made
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if let answer = ShellPolicy.syncBridgeAnswer(toPrompt: prompt) {
            completionHandler(answer)
            return
        }
        if original.webView?(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText, initiatedByFrame: frame, completionHandler: completionHandler) == nil {
            completionHandler(nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        if original.webView?(webView, runJavaScriptAlertPanelWithMessage: message, initiatedByFrame: frame, completionHandler: completionHandler) == nil {
            completionHandler()
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        if original.webView?(webView, runJavaScriptConfirmPanelWithMessage: message, initiatedByFrame: frame, completionHandler: completionHandler) == nil {
            completionHandler(false)
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    #if os(iOS)
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
    #endif
}

/// Stands in for Capacitor as the page's "bridge" script message handler and
/// passes on only what ShellPolicy.allowsBridgeMessage allows, from the live
/// site's own top-level page. Holds Capacitor's handler weakly: Capacitor's
/// bridge owns it, and the content controller owns this.
final class BridgeMessageFilter: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    private let serverURL: URL

    init(target: WKScriptMessageHandler, serverURL: URL) {
        self.target = target
        self.serverURL = serverURL
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        var parts = URLComponents()
        parts.scheme = origin.protocol
        parts.host = origin.host
        parts.port = origin.port == 0 ? nil : origin.port
        parts.path = "/"
        guard ShellPolicy.allowsBridgeMessage(
            message.body,
            fromMainFrame: message.frameInfo.isMainFrame,
            originURL: parts.url,
            serverURL: serverURL
        ) else {
            ShellLog.note("dropped a bridge message this app does not allow")
            return
        }
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// Which delegate methods a stand-in fails to pass on.
enum DelegateCoverage {
    /// The methods of an Objective-C protocol that `original` implements and
    /// `proxy` does not, by selector, sorted. Empty when nothing is missed.
    static func missing(in protocolName: String, original: NSObjectProtocol, proxy: NSObjectProtocol) -> [String] {
        guard let proto = objc_getProtocol(protocolName) else {
            return ["(no protocol named \(protocolName))"]
        }
        var missed: [String] = []
        for isRequired in [true, false] {
            var count: UInt32 = 0
            guard let methods = protocol_copyMethodDescriptionList(proto, isRequired, true, &count) else {
                continue
            }
            for index in 0..<Int(count) {
                guard let selector = methods[index].name else { continue }
                if original.responds(to: selector) && !proxy.responds(to: selector) {
                    missed.append(NSStringFromSelector(selector))
                }
            }
            free(methods)
        }
        return missed.sorted()
    }
}
