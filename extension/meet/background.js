/**
 * TipTop Kraken: Meet names (D-076). The extension's service worker.
 *
 * Passes Meet roster snapshots to the Kraken tab, and only when all three
 * hold: the person switched "Send Meet names to Kraken" on in the popup (off
 * until then), a Kraken tab said a recording is running, and that its
 * consent step was confirmed. Names go from one tab to the other on this
 * computer; the extension itself sends nothing to any server.
 *
 * State lives in chrome.storage because the worker can be stopped at any
 * time: 'sendNames' in local storage, the recording in session storage.
 */
'use strict';

var DEFAULT_STATE = {
  copilotTabId: null,
  meetingId: null,
  recording: false,
  consent: false,
  meetTabs: [],
};

function getState() {
  return new Promise(function (resolve) {
    chrome.storage.session.get('state', function (items) {
      resolve(Object.assign({}, DEFAULT_STATE, (items && items.state) || {}));
    });
  });
}

function setState(state) {
  return new Promise(function (resolve) {
    chrome.storage.session.set({ state: state }, resolve);
  });
}

function getEnabled() {
  return new Promise(function (resolve) {
    chrome.storage.local.get('sendNames', function (items) {
      resolve(Boolean(items && items.sendNames === true));
    });
  });
}

/** Names flow only with the switch on and a consented recording running. */
function relayOn(state, enabled) {
  return Boolean(enabled && state.recording && state.consent && state.copilotTabId !== null);
}

function tellTab(tabId, message) {
  if (tabId === null || tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, message, function () {
    void chrome.runtime.lastError;
  });
}

async function broadcast() {
  var state = await getState();
  var enabled = await getEnabled();
  var on = relayOn(state, enabled);
  state.meetTabs.forEach(function (tabId) {
    tellTab(tabId, { kind: 'relay', on: on });
  });
  tellTab(state.copilotTabId, { kind: 'hello', enabled: enabled });
}

async function handle(message, tabId) {
  var state = await getState();
  var enabled = await getEnabled();
  switch (message.kind) {
    case 'meet-hello':
      if (tabId !== null && state.meetTabs.indexOf(tabId) < 0) state.meetTabs.push(tabId);
      await setState(state);
      tellTab(tabId, { kind: 'relay', on: relayOn(state, enabled) });
      return { ok: true };
    case 'recording-state':
      if (tabId === null) return { ok: false };
      if (message.recording === true) {
        state.copilotTabId = tabId;
        state.meetingId = String(message.meetingId || '');
        state.recording = true;
        state.consent = message.consent === true;
      } else if (state.copilotTabId === tabId) {
        state.recording = false;
        state.consent = false;
        state.meetingId = null;
      }
      await setState(state);
      await broadcast();
      return { ok: true };
    case 'roster':
      if (relayOn(state, enabled) && state.meetTabs.indexOf(tabId) >= 0) {
        tellTab(state.copilotTabId, { kind: 'roster', payload: message.payload });
      }
      return { ok: true };
    case 'get-status':
      return {
        enabled: enabled,
        recording: state.recording,
        consent: state.consent,
        meetTabs: state.meetTabs.length,
      };
    case 'set-enabled':
      await new Promise(function (resolve) {
        chrome.storage.local.set({ sendNames: message.enabled === true }, resolve);
      });
      await broadcast();
      return { enabled: message.enabled === true };
    default:
      return { ok: false };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== 'object') return false;
  var tabId = sender && sender.tab && sender.tab.id !== undefined ? sender.tab.id : null;
  handle(message, tabId).then(sendResponse, function () {
    sendResponse({ ok: false });
  });
  return true; // answers asynchronously
});

chrome.tabs.onRemoved.addListener(async function (tabId) {
  var state = await getState();
  state.meetTabs = state.meetTabs.filter(function (id) {
    return id !== tabId;
  });
  if (state.copilotTabId === tabId) {
    state.copilotTabId = null;
    state.recording = false;
    state.consent = false;
    state.meetingId = null;
  }
  await setState(state);
  await broadcast();
});
