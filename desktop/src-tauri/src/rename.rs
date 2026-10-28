//! From 0.5.0 the app is named TipTop Kraken. On a Mac the updater swaps the
//! new app in place of the old one, so a copy updated from 0.4.x still sits in
//! a folder named "TipTop Copilot.app" (Finder, Launchpad and Spotlight show
//! that folder name). At launch, a copy running from such a folder renames it
//! to "TipTop Kraken.app" and starts again from there.
//!
//! It only ever renames the bundle this process runs from, inside the folder
//! it already sits in, and leaves things as they are when:
//! - the copy runs from a read-only place (a disk image, App Translocation);
//! - a "TipTop Kraken.app" already sits next to it (never replaced);
//! - the folder cannot be written (a standard user in /Applications): the
//!   rename simply fails and the app carries on under the old folder name.
//!
//! The app's data, sign-in and alerts token live under the identifier
//! (`vc.tiptop.copilot`), which did not change, so nothing else moves.
//! Windows needs none of this: its installer removes the old copy
//! (`windows/installer-hooks.nsh`).

// Only a Mac release build calls it; the tests run everywhere.
#![cfg_attr(not(all(target_os = "macos", not(debug_assertions))), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The bundle folder up to 0.4.x.
pub const OLD_BUNDLE: &str = "TipTop Copilot.app";
/// The bundle folder from 0.5.0 (tauri.conf.json productName).
pub const NEW_BUNDLE: &str = "TipTop Kraken.app";

#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Nothing to do.
    Stay,
    /// Rename `from` to `to` (same parent folder), then start again from `to`.
    Rename { from: PathBuf, to: PathBuf },
}

/// What to do for an app whose binary is `exe`
/// (…/TipTop Copilot.app/Contents/MacOS/<binary>). `read_only` says whether
/// the bundle sits on a read-only volume; `exists` whether a path exists.
pub fn plan(exe: &Path, read_only: bool, exists: impl Fn(&Path) -> bool) -> Plan {
    if read_only || exe.to_string_lossy().contains("/AppTranslocation/") {
        return Plan::Stay;
    }
    let Some(macos) = exe.parent() else {
        return Plan::Stay;
    };
    let Some(contents) = macos.parent() else {
        return Plan::Stay;
    };
    let Some(bundle) = contents.parent() else {
        return Plan::Stay;
    };
    if macos.file_name().and_then(|n| n.to_str()) != Some("MacOS")
        || contents.file_name().and_then(|n| n.to_str()) != Some("Contents")
        || bundle.file_name().and_then(|n| n.to_str()) != Some(OLD_BUNDLE)
    {
        return Plan::Stay;
    }
    let Some(parent) = bundle.parent() else {
        return Plan::Stay;
    };
    if parent.as_os_str().is_empty() {
        return Plan::Stay;
    }
    let to = parent.join(NEW_BUNDLE);
    if exists(&to) {
        return Plan::Stay;
    }
    Plan::Rename {
        from: bundle.to_path_buf(),
        to,
    }
}

/// Runs first thing at launch, before any plugin. Returns true when the
/// bundle was renamed and a new launch from the new folder is on its way, in
/// which case this process must end at once (the single-instance plugin
/// would otherwise hand the new launch back to it). A development build
/// never renames anything.
#[cfg(all(target_os = "macos", not(debug_assertions)))]
pub fn relaunch_under_new_name() -> bool {
    use std::process::{Command, Stdio};

    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return false;
    };
    let bundle = exe.ancestors().nth(3).unwrap_or(exe.as_path());
    let read_only = crate::updates::mac::on_read_only_volume(bundle);
    let Plan::Rename { from, to } = plan(&exe, read_only, |p| p.exists()) else {
        return false;
    };
    // rename(2) never replaces a non-empty folder, so a "TipTop Kraken.app"
    // that appeared since the check is left alone.
    if std::fs::rename(&from, &to).is_err() {
        return false;
    }
    // Waits for this process to end, then opens the renamed app. The paths go
    // in as arguments, never into the script.
    let started = Command::new("/bin/sh")
        .arg("-c")
        .arg(r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2""#)
        .arg("sh")
        .arg(std::process::id().to_string())
        .arg(&to)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok();
    if !started {
        // Could not start again: put the folder back and carry on as before,
        // so the updater still finds the bundle where this process runs from.
        let _ = std::fs::rename(&to, &from);
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "Contents/MacOS/tiptop-copilot-desktop";

    fn exe(bundle: &str) -> PathBuf {
        PathBuf::from(format!("{bundle}/{BIN}"))
    }

    fn nothing_exists(_: &Path) -> bool {
        false
    }

    #[test]
    fn an_updated_copy_in_applications_is_renamed() {
        assert_eq!(
            plan(&exe("/Applications/TipTop Copilot.app"), false, nothing_exists),
            Plan::Rename {
                from: PathBuf::from("/Applications/TipTop Copilot.app"),
                to: PathBuf::from("/Applications/TipTop Kraken.app"),
            }
        );
    }

    #[test]
    fn a_copy_anywhere_writable_is_renamed_where_it_is() {
        let home = exe("/Users/sam/Applications/TipTop Copilot.app");
        assert_eq!(
            plan(&home, false, nothing_exists),
            Plan::Rename {
                from: PathBuf::from("/Users/sam/Applications/TipTop Copilot.app"),
                to: PathBuf::from("/Users/sam/Applications/TipTop Kraken.app"),
            }
        );
    }

    #[test]
    fn the_new_name_or_any_other_name_stays() {
        for bundle in [
            "/Applications/TipTop Kraken.app",
            "/Applications/TipTop Copilot 2.app",
            "/Applications/My Copilot.app",
        ] {
            assert_eq!(plan(&exe(bundle), false, nothing_exists), Plan::Stay, "{bundle}");
        }
    }

    #[test]
    fn an_existing_kraken_app_is_never_replaced() {
        let taken = |p: &Path| p == Path::new("/Applications/TipTop Kraken.app");
        let old = exe("/Applications/TipTop Copilot.app");
        assert_eq!(plan(&old, false, taken), Plan::Stay);
    }

    #[test]
    fn a_read_only_copy_stays() {
        // Opened from the disk image.
        let dmg = exe("/Volumes/TipTop Copilot/TipTop Copilot.app");
        assert_eq!(plan(&dmg, true, nothing_exists), Plan::Stay);
        // Still in Downloads, run through App Translocation.
        assert_eq!(
            plan(
                &exe("/private/var/folders/ab/cd/T/AppTranslocation/0A1B2C/d/TipTop Copilot.app"),
                false,
                nothing_exists
            ),
            Plan::Stay
        );
    }

    #[test]
    fn a_binary_outside_a_bundle_stays() {
        for path in [
            "/Applications/TipTop Copilot.app/tiptop-copilot-desktop",
            "/Applications/TipTop Copilot.app/Contents/Resources/tool",
            "/TipTop Copilot.app/Other/MacOS/tiptop-copilot-desktop",
            "TipTop Copilot.app/Contents/MacOS/tiptop-copilot-desktop",
            "tiptop-copilot-desktop",
            "",
        ] {
            assert_eq!(plan(Path::new(path), false, nothing_exists), Plan::Stay, "{path}");
        }
    }

    #[test]
    fn the_names_match_the_product_name() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let product = conf["productName"].as_str().expect("productName");
        assert_eq!(format!("{product}.app"), NEW_BUNDLE);
        assert_eq!(conf["identifier"], "vc.tiptop.copilot");
    }
}
