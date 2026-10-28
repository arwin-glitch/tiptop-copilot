//! Where a URL may open: in the app, in the system browser, or nowhere.
//!
//! The window has no address bar, so anything that loads in it looks like
//! Kraken. Only the live site (over https), the bundled fallback page and
//! the blank page a new window starts on may load there.
use tauri::Url;

pub const LIVE_HOST: &str = "copilot.tiptop.vc";

/// Paths on the live host that must never load in the app. Google refuses
/// sign-in inside an app window, and both flows keep state in cookies the
/// system browser does not have. The web app hides these links in the desktop
/// app; this is the backstop.
const BROWSER_ONLY_PATHS: &[&str] = &["/api/auth/google", "/api/integrations/google/start"];

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    InApp,
    Browser,
    Block,
}

/// The live site itself: https on the standard port, with no user name or
/// password in front of the host.
pub(crate) fn is_live(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(LIVE_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn route(url: &Url) -> Route {
    match url.scheme() {
        // The bundled fallback page: tauri://localhost on a Mac,
        // http://tauri.localhost on Windows.
        "tauri" if url.host_str() == Some("localhost") => Route::InApp,
        "http" if url.host_str() == Some("tauri.localhost") => Route::InApp,
        // A new window starts blank; srcdoc is an inline frame's own page.
        "about" if matches!(url.path(), "blank" | "srcdoc") => Route::InApp,
        // A file the live site built in the page (a CSV export), and nothing
        // made by any other origin.
        "blob" if Url::parse(url.path()).is_ok_and(|inner| is_live(&inner)) => Route::InApp,
        "https" if is_live(url) => {
            if BROWSER_ONLY_PATHS.contains(&url.path().trim_end_matches('/')) {
                Route::Block
            } else {
                Route::InApp
            }
        }
        // The live site over plain http never loads.
        "http" if url.host_str() == Some(LIVE_HOST) => Route::Block,
        "http" | "https" | "mailto" | "tel" => Route::Browser,
        // data:, file:, javascript: and everything else.
        _ => Route::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route_of(url: &str) -> Route {
        route(&Url::parse(url).expect("test URLs are valid"))
    }

    fn assert_routes(urls: &[&str], expected: Route) {
        for url in urls {
            assert_eq!(route_of(url), expected, "{url}");
        }
    }

    #[test]
    fn live_site_and_local_pages_open_in_the_app() {
        assert_routes(
            &[
                "https://copilot.tiptop.vc/today",
                "https://copilot.tiptop.vc:443/today",
                "https://copilot.tiptop.vc/api/briefings/morning/view",
                "https://copilot.tiptop.vc/api/auth/callback?code=fictional",
                "https://copilot.tiptop.vc/api/auth/google-later",
                "https://copilot.tiptop.vc/desktop/callback?h=fictional",
                "tauri://localhost/index.html",
                "http://tauri.localhost/index.html",
                "about:blank",
                "about:srcdoc",
                "blob:https://copilot.tiptop.vc/0b1c",
            ],
            Route::InApp,
        );
    }

    #[test]
    fn other_sites_open_in_the_browser() {
        assert_routes(
            &[
                "https://mail.google.com/mail/u/0/#all/abc",
                "https://abcdefgh.supabase.co/auth/v1/authorize?provider=google",
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://tiptop-copilot.onrender.com/today",
                "https://copilot.tiptop.vc.example.com/",
                "https://copilot.tiptop.vc@evil.example/",
                "https://someone@copilot.tiptop.vc/today",
                "https://copilot.tiptop.vc:8443/today",
                "http://example.com/",
                "mailto:someone@example.com",
                "tel:+15555550100",
            ],
            Route::Browser,
        );
    }

    #[test]
    fn sign_in_starts_never_load_in_the_app() {
        assert_routes(
            &[
                "https://copilot.tiptop.vc/api/auth/google",
                "https://copilot.tiptop.vc/api/auth/google/",
                "https://copilot.tiptop.vc/api/auth/google?next=/x",
                "https://copilot.tiptop.vc/api/integrations/google/start?send=1",
            ],
            Route::Block,
        );
    }

    #[test]
    fn everything_else_is_refused() {
        assert_routes(
            &[
                "http://copilot.tiptop.vc/today",
                "data:text/html,<h1>Kraken</h1>",
                "about:settings",
                "blob:null/0b1c",
                "blob:https://evil.example/0b1c",
                "blob:http://copilot.tiptop.vc/0b1c",
                "tauri://evil/index.html",
                "file:///etc/hosts",
                "javascript:alert(1)",
                "smb://host/share",
            ],
            Route::Block,
        );
    }
}
