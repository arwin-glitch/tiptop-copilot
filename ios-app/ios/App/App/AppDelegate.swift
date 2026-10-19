import UIKit
import UserNotifications
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.

        // Apple requires a notification delegate before launch finishes, and
        // Capacitor only sets its own once the scene connects, later. This one
        // keeps an alert tap that launched the app until then.
        UNUserNotificationCenter.current().delegate = NotificationLaunchRelay.shared
        return true
    }

    // The two methods @capacitor/push-notifications asks for (its README):
    // they pass the device's push token, or the reason there is none, to the
    // plugin, which gives it to the page as its "registration" event.

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// The notification delegate from launch until Capacitor's own takes over.
///
/// Capacitor 8 makes its bridge, and with it the NotificationRouter that
/// becomes the delegate, when the scene connects: after launch has finished.
/// A tap on an alert that starts the app can arrive before that. This holds
/// it, and TipTopBridgeViewController passes it to the router once the screen
/// is up, so the push plugin delivers it to the page when the page listens.
/// A tap that arrives later goes to the router directly and never comes here.
final class NotificationLaunchRelay: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationLaunchRelay()

    private let lock = NSLock()
    private var heldTap: UNNotificationResponse?

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        lock.lock()
        heldTap = response
        lock.unlock()
        ShellLog.note("held an alert tap until the app is ready")
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // The same as plugins.PushNotifications.presentationOptions.
        completionHandler([.banner, .list, .sound])
    }

    /// Gives a held tap to Capacitor's notification router, once.
    func handOver(to router: UNUserNotificationCenterDelegate) {
        lock.lock()
        let tap = heldTap
        heldTap = nil
        lock.unlock()
        guard let tap else { return }
        ShellLog.note("passed a held alert tap to the page")
        router.userNotificationCenter?(UNUserNotificationCenter.current(), didReceive: tap, withCompletionHandler: {})
    }
}
