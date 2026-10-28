/**
 * The app moved from copilot.tiptop.vc to kraken.tiptop.vc (the TipTop Kraken
 * rename). Every name serves the same deployment; this sends a browser on an
 * old name (copilot.tiptop.vc, or Render's own tiptop-copilot.onrender.com) to
 * the same page on the new one, path, query and hash intact, so every link
 * already sent (booking links, emails, bookmarks) keeps working.
 *
 * It is an inline script rather than a proxy redirect because only the page
 * can tell the desktop app apart from a browser on the very first load: the
 * shell defines window.__TIPTOP_DESKTOP__ (and the tiptop_desktop cookie)
 * before any page script runs, but only on copilot.tiptop.vc, and every
 * released shell is locked to that host (navigation, IPC capability, the
 * updater). So the desktop app stays on the old name until a release moves
 * it. Also left alone: frames, and /desktop/ (the browser leg of desktop
 * sign-in, so a hand-off already under way finishes where it started).
 *
 * Event pages (/e) never run it: their nonce CSP refuses inline scripts, and
 * an old event link simply keeps working on the old name.
 */
export const OLD_APP_HOSTS = ['copilot.tiptop.vc', 'tiptop-copilot.onrender.com'] as const;
export const NEW_APP_ORIGIN = 'https://kraken.tiptop.vc';

export const DOMAIN_MOVE_SCRIPT = `(function(){try{var w=window,l=w.location;if(${JSON.stringify(OLD_APP_HOSTS)}.indexOf(l.hostname)<0||w.top!==w||typeof w.__TIPTOP_DESKTOP__!=='undefined'||/(?:^|;\\s*)tiptop_desktop=/.test(document.cookie)||l.pathname.indexOf('/desktop/')===0)return;l.replace('${NEW_APP_ORIGIN}'+l.pathname+l.search+l.hash)}catch(e){}})();`;
