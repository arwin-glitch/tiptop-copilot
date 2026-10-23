/**
 * TipTop Copilot: Meet names (D-076). The popup: the on/off switch, what is
 * happening now, and the button that posts the consent notice in the Meet
 * chat (only when pressed).
 */
'use strict';

var statusEl = document.getElementById('status');
var enabledEl = document.getElementById('enabled');
var noticeEl = document.getElementById('notice');
var noticeResultEl = document.getElementById('noticeResult');

function render(status) {
  enabledEl.checked = Boolean(status && status.enabled);
  if (!status) {
    statusEl.textContent = 'The extension is starting. Try again in a moment.';
  } else if (status.recording && status.consent) {
    statusEl.textContent = status.enabled
      ? 'Copilot is recording with consent: sending names.'
      : 'Copilot is recording. Switch names on to send them.';
  } else {
    statusEl.textContent = 'Copilot is not recording. Nothing is sent.';
  }
}

function refresh() {
  chrome.runtime.sendMessage({ kind: 'get-status' }, function (status) {
    void chrome.runtime.lastError;
    render(status);
  });
}

refresh();

enabledEl.addEventListener('change', function () {
  chrome.runtime.sendMessage({ kind: 'set-enabled', enabled: enabledEl.checked }, function () {
    void chrome.runtime.lastError;
    refresh();
  });
});

noticeEl.addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || tab.id === undefined) return;
    chrome.tabs.sendMessage(tab.id, { kind: 'post-notice' }, function (response) {
      if (chrome.runtime.lastError || !response) {
        noticeResultEl.textContent = 'Open this from your Google Meet tab.';
      } else if (response.result === 'no_chat') {
        noticeResultEl.textContent = 'Open the Meet chat panel first, then press again.';
      } else {
        noticeResultEl.textContent = 'Posted the notice in the chat.';
      }
    });
  });
});
