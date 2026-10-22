/**
 * TipTop Copilot: Meet names (D-076). Runs on Copilot's own pages.
 *
 * The bridge between the Copilot page and the extension: the page says when a
 * recording with a confirmed consent step is running ('recording-state'), and
 * names from Meet come back to the page as window messages on this origin
 * only. The page checks every message itself (src/lib/capture/meet-roster.ts).
 */
(function () {
  'use strict';
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  var PAGE_SOURCE = 'tiptop-copilot';
  var EXTENSION_SOURCE = 'tiptop-meet-extension';
  var VERSION = 1;

  function toPage(message) {
    window.postMessage(message, window.location.origin);
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, function () {
        void chrome.runtime.lastError;
      });
    } catch (_error) {
      // The extension was reloaded; nothing to do on this page.
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    var d = event.data;
    if (!d || d.source !== PAGE_SOURCE || d.version !== VERSION || d.type !== 'recording-state') {
      return;
    }
    send({
      kind: 'recording-state',
      meetingId: String(d.meetingId || '').slice(0, 64),
      recording: d.recording === true,
      consent: d.consent === true,
    });
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || typeof message !== 'object') return undefined;
    if (
      message.kind === 'roster' &&
      message.payload &&
      message.payload.source === EXTENSION_SOURCE
    ) {
      toPage(message.payload);
    } else if (message.kind === 'hello') {
      toPage({
        source: EXTENSION_SOURCE,
        version: VERSION,
        type: 'hello',
        enabled: message.enabled === true,
      });
    }
    return undefined;
  });
})();
