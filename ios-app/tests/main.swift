// Checks for the shell's own code, run by the iOS workflow on the Mac runner
// itself (macOS has the same WebKit delegate protocols as iOS). From ios-app/:
//
//   xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" \
//     -o shell-tests ios/App/App/ShellPolicy.swift \
//     ios/App/App/WebViewProxies.swift tests/main.swift
//   ./shell-tests
//
// No simulator and no Capacitor: ShellPolicy is plain Foundation, and the
// WebKit stand-ins are checked against a fake of Capacitor's delegate. Every
// address here is the live site's own or a made-up one.

import Foundation
import WebKit

var failures = 0
var checks = 0

func check(_ condition: Bool, _ what: String) {
    checks += 1
    if !condition {
        failures += 1
        print("FAIL: \(what)")
    }
}

let server = URL(string: "https://copilot.tiptop.vc/")!

func url(_ text: String) -> URL { URL(string: text)! }

// MARK: - Bridge messages

func allows(_ body: Any, mainFrame: Bool = true, origin: URL? = URL(string: "https://copilot.tiptop.vc/")) -> Bool {
    ShellPolicy.allowsBridgeMessage(body, fromMainFrame: mainFrame, originURL: origin, serverURL: server)
}

for plugin in ["PushNotifications", "App", "SystemBars", "Console"] {
    let call: [String: Any] = ["type": "message", "pluginId": plugin, "methodName": "x", "callbackId": "1", "options": [:]]
    check(allows(call), "\(plugin) calls pass")
}
for plugin in ["CapacitorHttp", "CapacitorCookies", "WebView", "Filesystem", ""] {
    check(!allows(["type": "message", "pluginId": plugin, "methodName": "request", "callbackId": "2"]),
          "\(plugin.isEmpty ? "an unnamed plugin" : plugin) calls are dropped")
}
check(allows(["type": "js.error", "error": ["message": "boom"]] as [String: Any]), "startup errors pass, for Capacitor's log")
check(!allows(["type": "cordova", "service": "x", "action": "y"]), "Cordova calls are dropped")
check(!allows(["pluginId": "App", "methodName": "getInfo"]), "a message with no type is dropped")
check(!allows("App"), "a message that is not an object is dropped")
check(!allows(["type": "message", "methodName": "getInfo"]), "a call with no plugin is dropped")
check(!allows(["type": "message", "pluginId": "App"], mainFrame: false), "a frame inside the page cannot call plugins")
check(!allows(["type": "message", "pluginId": "App"], origin: url("capacitor://localhost/")),
      "the bundled offline page cannot call plugins")
check(!allows(["type": "message", "pluginId": "App"], origin: url("https://copilot.tiptop.vc.example.com/")),
      "a look-alike site cannot call plugins")
check(!allows(["type": "message", "pluginId": "App"], origin: nil), "a message with no origin is dropped")

// MARK: - The prompt() channel

check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"type":"CapacitorCookies.isEnabled"}"#) == "false",
      "cookies report off")
check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"type":"CapacitorHttp"}"#) == "false", "native HTTP reports off")
check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"type":"CapacitorCookies.get"}"#) == "", "cookie reads get nothing")
check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"type":"CapacitorCookies.set","action":"a=b","domain":"x"}"#) == "",
      "cookie writes are ignored")
check(ShellPolicy.syncBridgeAnswer(toPrompt: "What is your name?") == nil, "an ordinary prompt() still shows")
check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"type":"Something else"}"#) == nil, "other JSON prompts still show")
check(ShellPolicy.syncBridgeAnswer(toPrompt: #"{"kind":"CapacitorHttp"}"#) == nil, "JSON with no type still shows")

// MARK: - The offline page

func error(_ domain: String, _ code: Int) -> Error { NSError(domain: domain, code: code) }

check(ShellPolicy.showsOfflinePage(for: error(NSURLErrorDomain, NSURLErrorNotConnectedToInternet)),
      "no connection shows the offline page")
check(ShellPolicy.showsOfflinePage(for: error(NSURLErrorDomain, NSURLErrorTimedOut)), "a timeout shows it")
check(ShellPolicy.showsOfflinePage(for: error(NSURLErrorDomain, NSURLErrorCannotFindHost)), "an unknown host shows it")
check(!ShellPolicy.showsOfflinePage(for: error(NSURLErrorDomain, NSURLErrorCancelled)),
      "a cancelled navigation keeps the page")
check(!ShellPolicy.showsOfflinePage(for: error("WebKitErrorDomain", 102)),
      "a load that became a download or a hand-off keeps the page")
check(!ShellPolicy.showsOfflinePage(for: error("WebKitErrorDomain", 204)), "media a plug-in plays keeps the page")
check(!ShellPolicy.showsOfflinePage(for: error(WKError.errorDomain, WKError.Code.unknown.rawValue)),
      "a WebKit error keeps the page")

// MARK: - The live site's own addresses

check(ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc/"), serverURL: server), "the start page")
check(ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc"), serverURL: server), "the site with no path")
check(ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc/api/briefings/morning/pdf"), serverURL: server),
      "a briefing PDF")
check(ShellPolicy.isAppAddress(url("https://COPILOT.tiptop.vc/inbox?thread=example"), serverURL: server),
      "any case, with a query")
check(!ShellPolicy.isAppAddress(url("http://copilot.tiptop.vc/"), serverURL: server), "plain http is not the site")
check(!ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc.example.com/"), serverURL: server),
      "a look-alike host is not the site")
check(!ShellPolicy.isAppAddress(url("https://example.com/https://copilot.tiptop.vc/"), serverURL: server),
      "another site is not the site")
check(!ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc@example.com/"), serverURL: server),
      "a user-name trick is not the site")
check(!ShellPolicy.isAppAddress(url("https://user@copilot.tiptop.vc/"), serverURL: server),
      "an address with a user name is not the site")
check(!ShellPolicy.isAppAddress(url("https://copilot.tiptop.vc:8443/"), serverURL: server), "another port is not the site")
check(!ShellPolicy.isAppAddress(url("blob:https://copilot.tiptop.vc/0000"), serverURL: server), "a blob: URL is not a page")

// MARK: - Downloads

check(ShellPolicy.isDownload(contentDisposition: "attachment; filename=\"contacts.csv\"", canShowMIMEType: true, statusCode: 200),
      "an attachment is saved")
check(ShellPolicy.isDownload(contentDisposition: "  ATTACHMENT", canShowMIMEType: true, statusCode: 200),
      "an attachment in capitals is saved")
check(!ShellPolicy.isDownload(contentDisposition: "inline; filename=\"brief.pdf\"", canShowMIMEType: true, statusCode: 200),
      "an inline PDF is shown")
check(!ShellPolicy.isDownload(contentDisposition: nil, canShowMIMEType: true, statusCode: 200), "a page is shown")
check(ShellPolicy.isDownload(contentDisposition: nil, canShowMIMEType: false, statusCode: 200),
      "a type WebKit cannot show is saved")
check(!ShellPolicy.isDownload(contentDisposition: nil, canShowMIMEType: false, statusCode: 204),
      "a 204 has nothing to save")

check(ShellPolicy.downloadFileName("contacts.csv") == "contacts.csv", "a plain name is kept")
check(ShellPolicy.downloadFileName("Deal memo – Example Co.pdf") == "Deal memo – Example Co.pdf",
      "spaces and dashes are kept")
check(ShellPolicy.downloadFileName("../../secret.txt") == "secret.txt", "folder parts are dropped")
check(ShellPolicy.downloadFileName("a/b\\c.txt") == "c.txt", "both kinds of slash are dropped")
check(ShellPolicy.downloadFileName(".profile") == "profile", "a leading dot is dropped")
check(ShellPolicy.downloadFileName("...") == "download", "dots alone become download")
check(ShellPolicy.downloadFileName("") == "download", "an empty name becomes download")
check(ShellPolicy.downloadFileName("a\u{0}b\nc.txt") == "abc.txt", "control characters are dropped")
check(ShellPolicy.downloadFileName("10:30 notes.txt") == "10-30 notes.txt", "colons become dashes")
let long = ShellPolicy.downloadFileName(String(repeating: "x", count: 300) + ".xlsx")
check(long.count == 120 && long.hasSuffix(".xlsx"), "a long name is cut to 120 characters, keeping its type")

// MARK: - The WebKit stand-ins

/// Records what reaches "Capacitor", standing in for its
/// WebViewDelegationHandler, which implements the methods below.
final class FakeCapacitorDelegate: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var calls: [String] = []

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        calls.append("reset")
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        calls.append("policy")
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        calls.append("finish")
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        calls.append("fail")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        calls.append("failProvisional")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        calls.append("terminate")
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @MainActor (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(.rejectProtectionSpace, nil)
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        completionHandler()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(defaultText)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        calls.append("message")
    }
}

/// One extra method, which the stand-in does not pass on.
final class FakeWithExtra: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {}
    func webView(_ webView: WKWebView, didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {}
}

@MainActor
func checkStandIns() {
    let capacitor = FakeCapacitorDelegate()
    let navigation = NavigationGuard(original: capacitor)
    let ui = UIDelegateGuard(original: capacitor, serverURL: server)
    let filter = BridgeMessageFilter(target: capacitor, serverURL: server)

    // The selectors WebKit calls. A method whose Swift signature only nearly
    // matches the protocol is not exposed under its selector and fails here.
    let navigationSelectors = [
        "webView:decidePolicyForNavigationAction:decisionHandler:",
        "webView:decidePolicyForNavigationResponse:decisionHandler:",
        "webView:didStartProvisionalNavigation:",
        "webView:didCommitNavigation:",
        "webView:didFinishNavigation:",
        "webView:didFailProvisionalNavigation:withError:",
        "webView:didFailNavigation:withError:",
        "webViewWebContentProcessDidTerminate:",
        "webView:didReceiveAuthenticationChallenge:completionHandler:",
        "webView:navigationAction:didBecomeDownload:",
        "webView:navigationResponse:didBecomeDownload:",
        "download:decideDestinationUsingResponse:suggestedFilename:completionHandler:",
        "downloadDidFinish:",
        "download:didFailWithError:resumeData:",
    ]
    for name in navigationSelectors {
        check(navigation.responds(to: NSSelectorFromString(name)), "NavigationGuard answers \(name)")
    }
    // WebKit prefers this variant when it exists, and would skip the one above.
    check(!navigation.responds(to: NSSelectorFromString("webView:decidePolicyForNavigationAction:preferences:decisionHandler:")),
          "NavigationGuard leaves the preferences variant of the policy method alone")

    let uiSelectors = [
        "webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:",
        "webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:",
        "webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:",
        "webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:",
        "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
    ]
    for name in uiSelectors {
        check(ui.responds(to: NSSelectorFromString(name)), "UIDelegateGuard answers \(name)")
    }
    check(filter.responds(to: NSSelectorFromString("userContentController:didReceiveScriptMessage:")),
          "BridgeMessageFilter answers script messages")

    // Nothing Capacitor's delegate handles is left out, and the check itself
    // notices a method that is.
    check(DelegateCoverage.missing(in: "WKNavigationDelegate", original: capacitor, proxy: navigation).isEmpty,
          "NavigationGuard passes on every navigation method the fake implements")
    check(DelegateCoverage.missing(in: "WKUIDelegate", original: capacitor, proxy: ui).isEmpty,
          "UIDelegateGuard passes on every UI method the fake implements")
    check(DelegateCoverage.missing(in: "WKNavigationDelegate", original: FakeWithExtra(), proxy: navigation)
            == ["webView:didReceiveServerRedirectForProvisionalNavigation:"],
          "the coverage check names a method that is not passed on")

    // What reaches Capacitor. The web view is only passed along, never loaded.
    let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())

    navigation.webView(webView, didStartProvisionalNavigation: nil)
    check(capacitor.calls.isEmpty, "starting a navigation does not reset Capacitor yet")
    navigation.webView(webView, didFailProvisionalNavigation: nil, withError: error(NSURLErrorDomain, NSURLErrorCancelled))
    check(capacitor.calls.isEmpty, "a cancelled navigation neither resets Capacitor nor shows the offline page")
    navigation.webView(webView, didFailProvisionalNavigation: nil, withError: error("WebKitErrorDomain", 102))
    check(capacitor.calls.isEmpty, "a navigation that became a download changes nothing")
    navigation.webView(webView, didCommit: nil)
    check(capacitor.calls == ["reset"], "a new page resets Capacitor once")
    navigation.webView(webView, didCommit: nil)
    check(capacitor.calls == ["reset"], "a second commit with no new navigation does not reset again")

    capacitor.calls = []
    navigation.webView(webView, didFailProvisionalNavigation: nil, withError: error(NSURLErrorDomain, NSURLErrorNotConnectedToInternet))
    check(capacitor.calls == ["failProvisional"], "no connection reaches Capacitor, which shows the offline page")
    navigation.webView(webView, didFail: nil, withError: error(NSURLErrorDomain, NSURLErrorNetworkConnectionLost))
    check(capacitor.calls == ["failProvisional", "fail"], "a lost connection mid-load reaches Capacitor too")
    navigation.webView(webView, didFail: nil, withError: error(NSURLErrorDomain, NSURLErrorCancelled))
    check(capacitor.calls == ["failProvisional", "fail"], "a cancelled load after commit keeps the page")
    navigation.webView(webView, didFinish: nil)
    check(capacitor.calls.last == "finish", "a finished load reaches Capacitor")
}

MainActor.assumeIsolated {
    checkStandIns()
}

print("\(checks - failures) of \(checks) checks passed.")
exit(failures == 0 ? 0 : 1)
