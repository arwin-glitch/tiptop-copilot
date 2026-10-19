import 'server-only';
import { NextResponse } from 'next/server';

/**
 * The answers the Google links get from inside the iPhone app, instead of
 * their redirect to Google. Google refuses to sign anyone in inside an app's
 * own web view, and the app hands any page that is not Copilot's to Safari,
 * which has neither the Copilot session nor the cookie the way back needs: so
 * the step could only fail there, after a trip through Google. The page
 * already hides these links in the app; this is the backstop, as the desktop
 * app blocks the same paths in its shell.
 *
 * Fixed pages with no input in them, on Copilot's own origin, so the app
 * keeps them in its window; a link goes back.
 */

interface Back {
  href: string;
  label: string;
}

/** Connecting Google: done on a computer ("Do this on your computer"). */
export function computerOnlyPage(what: string, back: Back) {
  return stopPage(
    'Do this on your computer',
    `${what} needs Google’s own sign-in page, which doesn’t open inside the iPhone app. Open Copilot on your computer and do it there. Everything else works here as usual.`,
    back,
  );
}

/**
 * Signing in: the app signs in through its own sign-in page, which finishes
 * in Safari (DesktopSignIn). Signing in on a computer would not sign the app
 * in, so this page never says to.
 */
export function signInHerePage(back: Back) {
  return stopPage(
    'Sign in from the sign-in page',
    'Google’s sign-in page doesn’t open inside the iPhone app. Go back and tap Sign in with Google: your browser opens so you can sign in there, then it brings you back.',
    back,
  );
}

function stopPage(heading: string, text: string, back: Back) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${heading} · TipTop Copilot</title>
<style>
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#f6f1e4;color:#1d2a24;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:calc(env(safe-area-inset-top) + 24px) 20px calc(env(safe-area-inset-bottom) + 24px);box-sizing:border-box}
main{max-width:26rem}
h1{font:600 1.375rem/1.3 ui-serif,Georgia,serif;margin:0 0 .5rem}
p{margin:0 0 1rem;color:#4a574f}
a{display:inline-block;margin-top:.5rem;padding:.625rem 1rem;border-radius:.5rem;background:#2b6d56;color:#fff;text-decoration:none;font-weight:500}
@media (prefers-color-scheme:dark){body{background:#0e0f0f;color:#ece7da}p{color:#b3ad9f}}
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<p>${text}</p>
<a href="${back.href}">${back.label}</a>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
