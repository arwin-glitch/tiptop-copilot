import UIKit
import WebKit
import Capacitor

/// The app's one screen: Capacitor's web view on copilot.tiptop.vc, with the
/// changes the live site needs inside an iPhone app (see WebViewProxies.swift
/// and ShellPolicy.swift for each one and why). SceneDelegate makes it in
/// place of Capacitor's own CAPBridgeViewController.
class TipTopBridgeViewController: CAPBridgeViewController {
    // The web view holds its delegates weakly, so they live here.
    private var navigationGuard: NavigationGuard?
    private var uiGuard: UIDelegateGuard?
    private var messageFilter: BridgeMessageFilter?
    private var handedOverLaunchTap = false

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // Lets window.open work without a tap to ride on: after the page has
        // fetched a meeting's join link, or when an alert tap opens one. It
        // reaches UIDelegateGuard, which keeps Copilot's own pages here and
        // passes other sites to Safari or their app, as a link would.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let webView, let capacitor = bridge as? CapacitorBridge else {
            ShellLog.note("the web view or the bridge is missing")
            return
        }
        let handler = capacitor.webViewDelegationHandler
        let serverURL = capacitor.config.serverURL

        // Swipe from the edge to go back, as in Safari. With the site's own
        // new-window links kept in the app, a full briefing, a PDF or an
        // attachment replaces the page, and has no back button of its own.
        webView.allowsBackForwardNavigationGestures = true

        // The launch screen's colour, light or dark with the phone, so nothing
        // flashes between it and the first page.
        let background = UIColor(named: "LaunchBackground") ?? .systemBackground
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background

        NavigationGuard.clearDownloads()
        let navigation = NavigationGuard(original: handler)
        navigation.onDownloadFinished = { [weak self] file in self?.share(file) }
        navigation.onDownloadFailed = { [weak self] in self?.tellDownloadFailed() }
        webView.navigationDelegate = navigation
        navigationGuard = navigation

        let ui = UIDelegateGuard(original: handler, serverURL: serverURL)
        webView.uiDelegate = ui
        uiGuard = ui

        // Capacitor adds its handler under this name when it starts; adding a
        // second one under the same name would throw, so it goes first.
        let filter = BridgeMessageFilter(target: handler, serverURL: serverURL)
        handler.contentController.removeScriptMessageHandler(forName: "bridge")
        handler.contentController.add(filter, name: "bridge")
        messageFilter = filter

        let missed = DelegateCoverage.missing(in: "WKNavigationDelegate", original: handler, proxy: navigation)
            + DelegateCoverage.missing(in: "WKUIDelegate", original: handler, proxy: ui)
        if missed.isEmpty {
            ShellLog.note("delegate check passed")
        } else {
            ShellLog.note("delegate check failed, not passed on: \(missed.joined(separator: ", "))")
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Once, and only from the screen people actually see: an alert tap
        // that launched the app before Capacitor existed (AppDelegate).
        if !handedOverLaunchTap, let capacitor = bridge as? CapacitorBridge {
            handedOverLaunchTap = true
            NotificationLaunchRelay.shared.handOver(to: capacitor.notificationRouter)
        }
    }

    // MARK: - Downloads

    /// Offers a downloaded file to the share sheet (Save to Files, AirDrop,
    /// Mail, and so on), then deletes it once the sheet closes.
    private func share(_ file: URL) {
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        // Needed if this ever runs on an iPad, where the sheet is a popover.
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        topPresenter().present(sheet, animated: true)
    }

    private func tellDownloadFailed() {
        let alert = UIAlertController(
            title: "The file could not be saved",
            message: "Check your connection and try again.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        topPresenter().present(alert, animated: true)
    }

    /// The screen on top, so a sheet can open over an alert or another sheet.
    private func topPresenter() -> UIViewController {
        var presenter: UIViewController = self
        while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
            presenter = presented
        }
        return presenter
    }
}
