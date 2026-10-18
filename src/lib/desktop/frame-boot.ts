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
export const FRAME_BOOT_SCRIPT = `(function(){try{var w=window,r=document.documentElement,f=w.__TIPTOP_DESKTOP_FRAME__,v=w.__TIPTOP_DESKTOP__;if((f==='windows'||f==='mac')&&typeof v==='string'&&/^\\d{1,4}\\.\\d{1,5}\\.\\d{1,6}$/.test(v=v.trim())){var p=v.split('.');if(+p[0]>0||+p[1]>=3){r.setAttribute('data-desktop-frame',f);var z=parseFloat(localStorage.getItem('tiptop-desktop-zoom'));if(z>=0.25&&z<=5)r.style.setProperty('--desktop-zoom',String(z));if(localStorage.getItem('tiptop-desktop-maximized')==='1')r.setAttribute('data-desktop-maximized','');}}}catch(e){}})();`;

/** Where FRAME_BOOT_SCRIPT finds the last zoom DesktopTitleBar saw. */
export const DESKTOP_ZOOM_KEY = 'tiptop-desktop-zoom';
/** And whether the window was maximised then ('1' or '0'). */
export const DESKTOP_MAXIMIZED_KEY = 'tiptop-desktop-maximized';
