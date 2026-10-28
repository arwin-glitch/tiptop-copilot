/**
 * TipTop Kraken: Meet names (D-076). Runs in Google Meet tabs.
 *
 * Reads the roster only while the background says a Kraken recording with a
 * confirmed consent step is running and the person has switched names on;
 * otherwise it reads nothing. It never posts in the meeting chat on its own:
 * the consent notice goes in only when the person presses the popup's button.
 */
(function () {
  'use strict';
  var M = globalThis.TipTopMeet;
  if (!M || typeof chrome === 'undefined' || !chrome.runtime) return;

  var relay = false;
  var tracker = new M.RosterTracker(10000);
  var observer = null;
  var interval = null;
  var pending = null;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        // The background may be asleep or reloading; the next tick tries again.
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The extension was reloaded; this page's copy of the script is orphaned.
      stop();
    }
  }

  function tick() {
    pending = null;
    if (!relay) return;
    var message = tracker.next(M.readRoster(document), Date.now());
    if (message) send({ kind: 'roster', payload: message });
  }

  function soon() {
    if (!pending) pending = setTimeout(tick, 250);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(soon);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-is-speaking', 'data-speaking', 'aria-label', 'data-participant-id'],
    });
    interval = setInterval(tick, 1000);
    tick();
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    if (interval) clearInterval(interval);
    interval = null;
    if (pending) clearTimeout(pending);
    pending = null;
  }

  function setRelay(on) {
    relay = on === true;
    if (relay) start();
    else stop();
  }

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || typeof message !== 'object') return undefined;
    if (message.kind === 'relay') {
      setRelay(message.on);
    } else if (message.kind === 'post-notice') {
      sendResponse({ result: M.postToChat(document, M.CONSENT_NOTICE_TEXT) });
    }
    return undefined;
  });

  send({ kind: 'meet-hello' });
})();
