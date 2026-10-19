// Compares the committed native project (ios-app/ios) with a fresh
// `npx cap add ios` from the same Capacitor CLI, so every difference from
// Capacitor's own 8.5.3 template is one this app made on purpose.
//
//   node scripts/check-native-project.mjs <fresh ios folder> <committed ios folder>
//
// The iOS workflow makes the fresh folder in a scratch copy of ios-app and
// runs this on every build. It fails on a file that differs from the
// template without being listed below, and on a listed file that no longer
// differs (the list is then out of date). JSON that says the same thing in a
// different layout counts as the same, since the repository's formatter lays
// out the asset catalog's JSON.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Made by `cap sync` on every build and ignored by git (ios/.gitignore). */
const GENERATED = [
  /^App\/App\/public\//,
  /^App\/App\/capacitor\.config\.json$/,
  /^App\/App\/config\.xml$/,
  /^capacitor-cordova-ios-plugins\//,
  /(^|\/)(xcuserdata|DerivedData|\.swiftpm|build)\//,
];

/** Files this app adds to the template. */
const ADDED = new Set([
  'App/App/App.entitlements',
  'App/App/ShellPolicy.swift',
  'App/App/TipTopBridgeViewController.swift',
  'App/App/WebViewProxies.swift',
  'App/App/Assets.xcassets/LaunchBackground.colorset/Contents.json',
  // Swift Package Manager's pins, if a build has committed them.
  'App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
]);

/** Template files this app removes: Capacitor's sample splash image. */
const REMOVED = [/^App\/App\/Assets\.xcassets\/Splash\.imageset\//];

/** Template files this app changes, and why (see ios-app/README.md). */
const CHANGED = {
  'App/App.xcodeproj/project.pbxproj':
    'bundle ID, iOS 16.4, iPhone only, version 1.0.0, entitlements, the three Swift files, manual signing on the App target for Release',
  'App/App/Info.plist':
    'name, URL scheme, encryption answer, usage strings, portrait only, no scene storyboard',
  'App/App/AppDelegate.swift': 'push token forwarding and the launch-tap relay',
  'App/App/SceneDelegate.swift': "this app's view controller",
  'App/App/Base.lproj/LaunchScreen.storyboard':
    'a plain light or dark colour instead of the sample splash',
  'App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png':
    'the TipTop icon from public/icon.svg',
  'App/CapApp-SPM/Package.swift': 'written by cap sync from the project: iOS 16 rather than 15',
};

function walk(root) {
  const files = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const path = relative(root, full).split(sep).join('/');
      if (statSync(full).isDirectory()) {
        visit(full);
      } else if (!GENERATED.some((pattern) => pattern.test(path))) {
        files.set(path, readFileSync(full));
      }
    }
  };
  visit(root);
  return files;
}

function sameJson(a, b) {
  try {
    return (
      JSON.stringify(JSON.parse(a.toString('utf8'))) ===
      JSON.stringify(JSON.parse(b.toString('utf8')))
    );
  } catch {
    return false;
  }
}

const [freshDir, committedDir] = process.argv.slice(2);
if (!freshDir || !committedDir) {
  console.log(
    'Usage: node scripts/check-native-project.mjs <fresh ios folder> <committed ios folder>',
  );
  process.exit(2);
}

const fresh = walk(freshDir);
const committed = walk(committedDir);
const problems = [];
const report = [];

for (const [path, ours] of committed) {
  const theirs = fresh.get(path);
  if (!theirs) {
    if (ADDED.has(path)) report.push(`added     ${path}`);
    else problems.push(`${path} is not in Capacitor's template and not listed as added.`);
    continue;
  }
  const identical = ours.equals(theirs);
  const sameContent = identical || (path.endsWith('.json') && sameJson(ours, theirs));
  if (CHANGED[path]) {
    if (identical) problems.push(`${path} is listed as changed but matches the template again.`);
    else report.push(`changed   ${path}: ${CHANGED[path]}`);
  } else if (identical) {
    report.push(`same      ${path}`);
  } else if (sameContent) {
    report.push(`same      ${path} (JSON laid out differently)`);
  } else {
    problems.push(`${path} differs from Capacitor's template but is not listed as changed.`);
  }
}
for (const path of fresh.keys()) {
  if (committed.has(path)) continue;
  if (REMOVED.some((pattern) => pattern.test(path))) report.push(`removed   ${path}`);
  else problems.push(`${path} from Capacitor's template is missing.`);
}

console.log(report.sort().join('\n'));
if (problems.length) {
  for (const problem of problems) console.log(`::error::${problem}`);
  process.exit(1);
}
console.log(
  `The native project is Capacitor's template plus the ${Object.keys(CHANGED).length} listed changes.`,
);
