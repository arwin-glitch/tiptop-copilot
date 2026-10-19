#!/usr/bin/env bash
# Opens a simulator build of the app on an iPhone simulator and checks the
# shell itself, with no Apple account and no keys. Run by the iOS workflow:
#
#   scripts/simulator-smoke.sh <path to App.app> <folder for screenshots and logs>
#
# Passes when the app starts and stays running, shows either the live site
# or (if the site cannot be reached from the runner) its offline page,
# reports that its delegate stand-ins pass on everything Capacitor handles,
# and opens from a vc.tiptop.copilot:// link. Leaves three screenshots
# (launch, after the link, dark mode) and the shell's log lines in the folder.
#
# It never signs in and never taps anything: the live site shows its sign-in
# page, which needs no account. What happens after sign-in is checked on a
# phone (ios-app/README.md) and in the web app's own iOS tests.

set -euo pipefail

app=${1:?pass the path to App.app}
out=${2:?pass a folder for the results}
bundle=vc.tiptop.copilot
mkdir -p "$out"

# The newest iOS runtime on the runner, and the first iPhone it has.
udid=$(xcrun simctl list devices available --json | node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => {
    const devices = JSON.parse(text).devices;
    const version = (key) => (key.match(/SimRuntime\.iOS-([\d-]+)$/)?.[1] ?? "").split("-").map(Number);
    const newerFirst = (a, b) => {
      const [x, y] = [version(a), version(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      }
      return 0;
    };
    for (const runtime of Object.keys(devices).filter((k) => /SimRuntime\.iOS-/.test(k)).sort(newerFirst)) {
      const phone = devices[runtime].find((d) => d.isAvailable !== false && /^iPhone/.test(d.name));
      if (phone) {
        console.error(`Using ${phone.name} on ${runtime.split(".").pop()}`);
        console.log(phone.udid);
        return;
      }
    }
    process.exit(1);
  });
') || { echo "::error::No iPhone simulator is installed on this runner."; exit 1; }

shell_log() {
  # The shell's own lines (ShellLog in ShellPolicy.swift) from the simulator's log.
  xcrun simctl spawn "$udid" log show --style compact --last 15m     --predicate 'eventMessage CONTAINS "TipTopShell:"' 2>/dev/null || true
}

# Each check reads a file rather than a pipe into grep -q: with pipefail, a
# grep that stops early could fail the pipe that fed it.
logged() {
  # logged <pattern>: true if a shell line matches.
  shell_log > "$out/.shell-now.log"
  grep -Eq "$1" "$out/.shell-now.log"
}

wait_for() {
  # wait_for <seconds> <pattern>: true once a shell line matches.
  local deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if logged "$2"; then return 0; fi
    sleep 5
  done
  return 1
}

running() {
  xcrun simctl spawn "$udid" launchctl list > "$out/.launchctl.log" 2>/dev/null || true
  grep -q "UIKitApplication:$bundle" "$out/.launchctl.log"
}

finish() {
  shell_log > "$out/shell.log"
  rm -f "$out/.shell-now.log" "$out/.launchctl.log"
  xcrun simctl spawn "$udid" log show --style compact --last 15m \
    --predicate 'process == "App"' > "$out/app-process.log" 2>/dev/null || true
  xcrun simctl terminate "$udid" "$bundle" > /dev/null 2>&1 || true
  xcrun simctl shutdown "$udid" > /dev/null 2>&1 || true
}
trap finish EXIT

xcrun simctl bootstatus "$udid" -b > /dev/null
xcrun simctl ui "$udid" appearance light
xcrun simctl install "$udid" "$app"
xcrun simctl launch --terminate-running-process \
  --stdout="$out/stdout.log" --stderr="$out/stderr.log" "$udid" "$bundle" > /dev/null

failed=0

# The live site can take up to a minute to wake, so up to three to show
# either it or the offline page.
if wait_for 180 'TipTopShell: loaded (the live site|the offline page)'; then
  if logged 'TipTopShell: loaded the live site'; then
    echo "The app showed the live site."
  else
    echo "::warning::The app showed its offline page: the live site did not answer the runner. The shell itself works; check the screenshot."
  fi
else
  echo "::error::The app showed neither the live site nor its offline page within three minutes."
  failed=1
fi
sleep 3
xcrun simctl io "$udid" screenshot "$out/1-launch.png" > /dev/null

if running; then
  echo "The app is running."
else
  echo "::error::The app is not running: it quit or crashed after launch (see app-process.log)."
  failed=1
fi

if logged 'TipTopShell: delegate check passed'; then
  echo "The delegate stand-ins pass on every method Capacitor handles."
else
  line=$(grep -o 'TipTopShell: delegate check failed.*' "$out/.shell-now.log" | head -n 1 || true)
  echo "::error::Delegate check did not pass: ${line:-no report}. Implement the listed methods in WebViewProxies.swift."
  failed=1
fi

# Proves the URL scheme is registered (simctl fails if no app claims it). The
# address has no sign-in code, so the page ignores it.
if xcrun simctl openurl "$udid" "$bundle://smoke-test" && wait_for 30 'TipTopShell: opened by a link to the app'; then
  echo "The app opens from a $bundle:// link."
else
  echo "::error::The app did not open from a $bundle:// link."
  failed=1
fi
sleep 2
xcrun simctl io "$udid" screenshot "$out/2-after-link.png" > /dev/null

xcrun simctl ui "$udid" appearance dark
sleep 4
xcrun simctl io "$udid" screenshot "$out/3-dark.png" > /dev/null

if ! running; then
  echo "::error::The app stopped running during the check."
  failed=1
fi

exit "$failed"
