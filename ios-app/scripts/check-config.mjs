// Checks the iPhone app's settings agree with each other and with what was
// reviewed, before anything is built. Run by the iOS workflow after `npm ci`
// in ios-app (it reads property lists with `plist`, which the Capacitor CLI
// brings):
//
//   node scripts/check-config.mjs
//
// Fails, with a line saying what to change, when:
// - the version differs between package.json, the user-agent token in
//   capacitor.config.json and MARKETING_VERSION in the Xcode project, or a
//   tag ios-vX.Y.Z does not match it;
// - the root package.json pins a @capacitor package at another version;
// - capacitor.config.json strays from the reviewed setup (the live site at
//   its root, nothing else allowed in the app, native HTTP and cookies off);
// - Info.plist, the entitlements or the Xcode project lose a reviewed value;
// - the app icon is not a 1024 x 1024 image without transparency.
// Warns when public/icon.svg has changed since the icon was drawn.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plist from 'plist';

const appDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(appDir, '..');
const problems = [];
const problem = (message) => problems.push(message);
const read = (path) => readFileSync(join(appDir, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const BUNDLE_ID = 'vc.tiptop.copilot';
const SERVER_URL = 'https://copilot.tiptop.vc/';
const PINS = {
  '@capacitor/app': '8.1.2',
  '@capacitor/cli': '8.5.3',
  '@capacitor/core': '8.5.3',
  '@capacitor/ios': '8.5.3',
  '@capacitor/push-notifications': '8.1.3',
};

// --- Versions ---------------------------------------------------------------

const pkg = json('package.json');
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) problem(`package.json version "${version}" must be X.Y.Z.`);

const config = json('capacitor.config.json');
const agent = config.ios?.appendUserAgent;
if (agent !== `TipTopCopilotiOS/${version}`) {
  problem(
    `capacitor.config.json ios.appendUserAgent is "${agent}"; set it to "TipTopCopilotiOS/${version}" (the web app reads this token).`,
  );
}

const pbxproj = read('ios/App/App.xcodeproj/project.pbxproj');
const settings = (name) =>
  [...pbxproj.matchAll(new RegExp(`\\b${name} = ([^;]+);`, 'g'))].map((m) => m[1]);
const marketing = settings('MARKETING_VERSION');
if (marketing.length !== 2 || marketing.some((v) => v !== version)) {
  problem(
    `MARKETING_VERSION in project.pbxproj is ${marketing.join(', ')}; set both to ${version}.`,
  );
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME ?? '';
  if (tag !== `ios-v${version}`)
    problem(`Tag ${tag} does not match version ${version}; tag ios-v${version}.`);
}

// --- Pinned packages ----------------------------------------------------------

const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const lock = json('package-lock.json');
for (const [name, pin] of Object.entries(PINS)) {
  if (declared[name] !== pin)
    problem(`ios-app/package.json must pin ${name} at exactly ${pin} (has "${declared[name]}").`);
  const locked = lock.packages?.[`node_modules/${name}`]?.version;
  if (locked !== pin)
    problem(`package-lock.json has ${name} ${locked}, not ${pin}: run npm install in ios-app.`);
}
const rootPkgPath = join(repoDir, 'package.json');
if (existsSync(rootPkgPath)) {
  const root = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const rootDeps = { ...root.dependencies, ...root.devDependencies };
  for (const [name, pin] of Object.entries(PINS)) {
    if (rootDeps[name] !== undefined && rootDeps[name] !== pin) {
      problem(
        `The root package.json has ${name} "${rootDeps[name]}"; the iPhone app is built with exactly ${pin}.`,
      );
    }
  }
}

// --- capacitor.config.json ------------------------------------------------------

if (config.appId !== BUNDLE_ID) problem(`capacitor.config.json appId must be ${BUNDLE_ID}.`);
if (config.server?.url !== SERVER_URL) {
  problem(
    `capacitor.config.json server.url must be exactly ${SERVER_URL}: the trailing slash keeps look-alike hosts out, and the root keeps every Copilot page in the app.`,
  );
}
if (config.server?.allowNavigation !== undefined) {
  problem(
    'capacitor.config.json must not set server.allowNavigation: only the live site loads in the app.',
  );
}
if (
  config.server?.errorPath !== 'offline.html' ||
  !existsSync(join(appDir, 'www', 'offline.html'))
) {
  problem(
    'capacitor.config.json server.errorPath must be offline.html, and www/offline.html must exist.',
  );
}
if (
  config.plugins?.CapacitorHttp?.enabled !== false ||
  config.plugins?.CapacitorCookies?.enabled !== false
) {
  problem(
    'capacitor.config.json must keep plugins.CapacitorHttp.enabled and plugins.CapacitorCookies.enabled false.',
  );
}
if (config.ios?.webContentsDebuggingEnabled !== false) {
  problem('capacitor.config.json ios.webContentsDebuggingEnabled must be false.');
}
if (config.ios?.limitsNavigationsToAppBoundDomains) {
  problem('capacitor.config.json must not turn on ios.limitsNavigationsToAppBoundDomains.');
}

// --- Info.plist, entitlements, Xcode project ------------------------------------

const info = plist.parse(read('ios/App/App/Info.plist'));
const expect = (ok, message) => {
  if (!ok) problem(`Info.plist: ${message}`);
};
expect(info.CFBundleDisplayName === 'TipTop', 'CFBundleDisplayName must be "TipTop".');
expect(
  info.ITSAppUsesNonExemptEncryption === false,
  'ITSAppUsesNonExemptEncryption must be false.',
);
expect(
  (info.CFBundleURLTypes ?? []).some((t) => (t.CFBundleURLSchemes ?? []).includes(BUNDLE_ID)),
  `CFBundleURLTypes must register the ${BUNDLE_ID} scheme (the sign-in return link).`,
);
for (const key of [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
]) {
  expect(
    typeof info[key] === 'string' && info[key].length > 10,
    `${key} must explain the use; without it iOS ends the app.`,
  );
}
expect(
  JSON.stringify(info.UISupportedInterfaceOrientations) ===
    JSON.stringify(['UIInterfaceOrientationPortrait']),
  'UISupportedInterfaceOrientations must be portrait only.',
);
const scenes =
  info.UIApplicationSceneManifest?.UISceneConfigurations?.UIWindowSceneSessionRoleApplication ?? [];
expect(
  scenes.length === 1 &&
    scenes[0].UISceneDelegateClassName === '$(PRODUCT_MODULE_NAME).SceneDelegate',
  'the scene must use SceneDelegate.',
);
expect(
  scenes.every((s) => s.UISceneStoryboardFile === undefined) &&
    info.UIMainStoryboardFile === undefined,
  'no storyboard may make the window: SceneDelegate makes the only one, with TipTopBridgeViewController.',
);
expect(
  info.UILaunchStoryboardName === 'LaunchScreen',
  'UILaunchStoryboardName must be LaunchScreen.',
);

const entitlements = plist.parse(read('ios/App/App/App.entitlements'));
if (entitlements['aps-environment'] !== 'development') {
  problem(
    'App.entitlements must keep aps-environment "development"; the release build sets the profile\'s value.',
  );
}

const count = (text) => pbxproj.split(text).length - 1;
const want = (text, times, why) => {
  if (count(text) !== times) problem(`project.pbxproj: expected ${times}x "${text}" (${why}).`);
};
want(`PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`, 2, 'the bundle ID');
want('IPHONEOS_DEPLOYMENT_TARGET = 16.4;', 4, 'iOS 16.4, the floor web push already needs');
want('TARGETED_DEVICE_FAMILY = 1;', 2, 'iPhone only');
want('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;', 2, 'push entitlements');
want('CODE_SIGN_STYLE = Manual;', 1, 'manual signing for Release, on the App target alone');
want(
  'PROVISIONING_PROFILE_SPECIFIER = "$(TIPTOP_PROFILE)";',
  1,
  'the profile comes from the release job',
);
want('DEVELOPMENT_TEAM = "$(TIPTOP_TEAM_ID)";', 1, 'the team comes from the release job');
for (const file of [
  'TipTopBridgeViewController.swift',
  'WebViewProxies.swift',
  'ShellPolicy.swift',
]) {
  want(`/* ${file} in Sources */,`, 1, `${file} is compiled`);
}

// --- App icon -------------------------------------------------------------------

const icon = readFileSync(
  join(appDir, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'),
);
const isPng = icon
  .subarray(0, 8)
  .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const [width, height, colourType] = isPng
  ? [icon.readUInt32BE(16), icon.readUInt32BE(20), icon[25]]
  : [0, 0, -1];
// Colour types 2 (RGB) and 0 (grey) carry no alpha; a tRNS chunk would add it.
if (
  !isPng ||
  width !== 1024 ||
  height !== 1024 ||
  ![0, 2].includes(colourType) ||
  icon.includes(Buffer.from('tRNS'))
) {
  problem(
    'The app icon must be a 1024 x 1024 PNG without transparency (ITMS-90717): run npm run icon in ios-app.',
  );
}
const svgPath = join(repoDir, 'public', 'icon.svg');
if (existsSync(svgPath)) {
  const drawnFrom = json('icon-source.json').sha256;
  const now = createHash('sha256').update(readFileSync(svgPath)).digest('hex');
  if (drawnFrom !== now) {
    console.log(
      '::warning::public/icon.svg has changed since the iPhone icon was drawn: run npm run icon in ios-app and commit.',
    );
  }
}

// ---------------------------------------------------------------------------------

if (problems.length) {
  for (const message of problems) console.log(`::error::${message}`);
  process.exit(1);
}
console.log(`iPhone app ${version}: settings agree.`);
