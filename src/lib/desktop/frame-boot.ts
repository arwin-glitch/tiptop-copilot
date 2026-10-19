import { FIRST_IOS_DOWNLOADS_VERSION, IOS_UA_RE } from '@/lib/ios/shared';

/**
 * Marks <html> with `data-desktop-frame="windows|mac"` when the page draws the
 * desktop app's top bar, the same call desktopFrame() in ./shared makes (a
 * unit test holds the two together): the main window of a 0.3.0 or newer
 * shell, which sets both globals. Everywhere else it does nothing, so a
 * browser and every older app render exactly as before.
 *
 * It runs before first paint, in the same inline script as the theme, so the
 * bar and the space under it are there in the first frame: no layout shift,
 * and no hydration mismatch, because the bar's markup is always rendered and
 * CSS alone shows it (globals.css, "The desktop app's top bar").
 *
 * The zoom it applies, and whether the window is maximised (which caption
 * glyph the maximise button shows), are cached display values: the app's own
 * View > Zoom, which keeps the bar the same size at any zoom, and the window
 * state, so a window that opens maximised shows "restore" from the first
 * frame. DesktopTitleBar refreshes both from the shell; neither is ever
 * authoritative.
 */
const DESKTOP_FRAME_BOOT = `(function(){try{var w=window,r=document.documentElement,f=w.__TIPTOP_DESKTOP_FRAME__,v=w.__TIPTOP_DESKTOP__;if((f==='windows'||f==='mac')&&typeof v==='string'&&/^\\d{1,4}\\.\\d{1,5}\\.\\d{1,6}$/.test(v=v.trim())){var p=v.split('.');if(+p[0]>0||+p[1]>=3){r.setAttribute('data-desktop-frame',f);var z=parseFloat(localStorage.getItem('tiptop-desktop-zoom'));if(z>=0.25&&z<=5)r.style.setProperty('--desktop-zoom',String(z));if(localStorage.getItem('tiptop-desktop-maximized')==='1')r.setAttribute('data-desktop-maximized','');}}}catch(e){}})();`;

/**
 * The iPhone app (ios-app/): marks <html> with `data-ios-app` when the user
 * agent carries the shell's `TipTopCopilotiOS/<version>` token, the same
 * test iosAppVersion() in lib/ios/shared makes (a unit test holds the two
 * together). The page runs under the status bar there, so globals.css moves
 * it down by the safe area and hides what the app cannot do ("The iPhone
 * app"). `data-ios-no-downloads` as well in an app that cannot save a
 * downloaded file (iosDownloadsShell). A layout hint, like the desktop flags.
 */
const IOS_FRAME_BOOT = `(function(){try{var n=window.navigator,m=/${IOS_UA_RE.source}/.exec(n&&n.userAgent||'');if(m){var r=document.documentElement,d=${JSON.stringify(FIRST_IOS_DOWNLOADS_VERSION)},a=m[1].split('.'),b=d?d.split('.'):null,i=0,c=0;r.setAttribute('data-ios-app','');while(b&&i<3&&!c){c=(+a[i])-(+b[i]);i++}if(!b||c<0)r.setAttribute('data-ios-no-downloads','');}}catch(e){}})();`;

export const FRAME_BOOT_SCRIPT = DESKTOP_FRAME_BOOT + IOS_FRAME_BOOT;

/** Where FRAME_BOOT_SCRIPT finds the last zoom DesktopTitleBar saw. */
export const DESKTOP_ZOOM_KEY = 'tiptop-desktop-zoom';
/** And whether the window was maximised then ('1' or '0'). */
export const DESKTOP_MAXIMIZED_KEY = 'tiptop-desktop-maximized';
