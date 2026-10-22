/**
 * TipTop Copilot: Meet names (D-076, v1 nice). Shared logic for the Meet tab.
 *
 * Reads who is in the call and who is speaking from Google Meet's page, and
 * finds the chat box for the consent notice. Meet's markup is not a public
 * API and changes without notice, so every lookup tries several selectors,
 * prefers accessibility attributes (aria-label, role) over class names, and
 * the whole reader is in this one file to update. When nothing matches it
 * reports an empty roster rather than guessing.
 *
 * Classic script (content scripts cannot be modules): it defines
 * globalThis.TipTopMeet for content-meet.js, and for the unit tests, which
 * run this file in a sandbox.
 */
(function (root) {
  'use strict';

  /** What [Copy notice] says in Copilot (CONSENT_NOTICE_TEXT in src/lib/types/notes.ts). */
  var CONSENT_NOTICE_TEXT =
    "Hi all, I'm using TipTop Copilot to transcribe and take notes on this call. Let me know if you'd rather I didn't.";

  var EXTENSION_SOURCE = 'tiptop-meet-extension';
  var PAGE_SOURCE = 'tiptop-copilot';
  var BRIDGE_VERSION = 1;
  var MAX_NAME = 120;
  var MAX_PEOPLE = 60;

  var SELECTORS = {
    /** Each participant's tile in the call grid. */
    tile: ['[data-participant-id]', '[data-requested-participant-id]'],
    /** The name inside a tile. Names sit in notranslate spans; self tiles carry data-self-name. */
    tileName: ['[data-self-name]', 'span.notranslate', '[data-tooltip]'],
    /** Rows of the People panel, named by aria-label. */
    peopleRow: [
      '[role="list"][aria-label*="articipant"] [role="listitem"][aria-label]',
      '[role="listitem"][aria-label][data-participant-id]',
    ],
    /** A tile marked as speaking. */
    speaking: [
      '[data-is-speaking="true"]',
      '[data-speaking="true"]',
      '[aria-label*="is speaking" i]',
    ],
    /** Live captions: the name on the newest caption is who is talking. */
    captionRegion: ['[role="region"][aria-label*="aption" i]'],
    captionName: ['[data-speaker-name]', 'span.notranslate', 'img[alt] + div', 'div > span'],
    /** The chat box and its send button. */
    chatInput: [
      'textarea[aria-label*="message" i]',
      '[contenteditable="true"][aria-label*="message" i]',
    ],
    chatSend: ['button[aria-label*="Send a message" i]', 'button[aria-label*="send" i]'],
  };

  /** "Dana Reyes", trimmed and bounded; null for empty or non-name strings. */
  function cleanName(value) {
    if (typeof value !== 'string') return null;
    var name = value.replace(/\s+/g, ' ').trim();
    if (!name) return null;
    // Labels Meet puts on tiles that are not names.
    if (/^(you|me|presentation|your presentation|\(you\))$/i.test(name)) return null;
    name = name.replace(/\s*\((you|presenting|host)\)\s*$/i, '');
    return name.slice(0, MAX_NAME) || null;
  }

  function first(el, selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var found = el.querySelector(selectors[i]);
      if (found) return found;
    }
    return null;
  }

  function all(el, selectors) {
    var out = [];
    for (var i = 0; i < selectors.length; i += 1) {
      var found = el.querySelectorAll(selectors[i]);
      for (var j = 0; j < found.length; j += 1) if (out.indexOf(found[j]) < 0) out.push(found[j]);
    }
    return out;
  }

  function nameOfTile(tile) {
    var el = first(tile, SELECTORS.tileName);
    if (el) {
      var fromAttr = el.getAttribute('data-self-name') || el.getAttribute('data-tooltip');
      var name = cleanName(fromAttr) || cleanName(el.textContent);
      if (name) return name;
    }
    return cleanName(tile.getAttribute('aria-label'));
  }

  /**
   * The call as the page shows it: { participants: string[], speaking: string[] }.
   * `root` is the document (or anything with querySelector/querySelectorAll).
   */
  function readRoster(rootEl) {
    var participants = [];
    var speaking = [];
    var add = function (list, name) {
      if (name && list.indexOf(name) < 0 && list.length < MAX_PEOPLE) list.push(name);
    };
    var tiles = all(rootEl, SELECTORS.tile);
    for (var i = 0; i < tiles.length; i += 1) {
      var name = nameOfTile(tiles[i]);
      add(participants, name);
      if (
        name &&
        (first(tiles[i], SELECTORS.speaking) ||
          tiles[i].getAttribute('data-is-speaking') === 'true')
      ) {
        add(speaking, name);
      }
    }
    var rows = all(rootEl, SELECTORS.peopleRow);
    for (var r = 0; r < rows.length; r += 1)
      add(participants, cleanName(rows[r].getAttribute('aria-label')));
    var region = first(rootEl, SELECTORS.captionRegion);
    if (region) {
      var names = all(region, SELECTORS.captionName);
      var last = names.length ? cleanName(names[names.length - 1].textContent) : null;
      if (last) {
        add(participants, last);
        add(speaking, last);
      }
    }
    return { participants: participants, speaking: speaking };
  }

  function sameList(a, b) {
    if (a.length !== b.length) return false;
    var sa = a.slice().sort();
    var sb = b.slice().sort();
    for (var i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return false;
    return true;
  }

  /**
   * Decides when a snapshot is worth sending: when who is there or who is
   * speaking changes, and otherwise every `heartbeatMs` so a new Copilot tab
   * catches up.
   */
  function RosterTracker(heartbeatMs) {
    this.heartbeatMs = heartbeatMs || 10000;
    this.last = null;
    this.lastSentAt = 0;
  }

  RosterTracker.prototype.next = function (snapshot, now) {
    var changed =
      !this.last ||
      !sameList(this.last.participants, snapshot.participants) ||
      !sameList(this.last.speaking, snapshot.speaking);
    if (!changed && now - this.lastSentAt < this.heartbeatMs) return null;
    this.last = snapshot;
    this.lastSentAt = now;
    return {
      source: EXTENSION_SOURCE,
      version: BRIDGE_VERSION,
      type: 'roster',
      participants: snapshot.participants.slice(),
      speaking: snapshot.speaking.slice(),
      at: now,
    };
  };

  /** The extension relays names only when all three hold. */
  function shouldRelay(state) {
    return Boolean(state && state.enabled && state.recording && state.consent);
  }

  /**
   * Put the consent notice in Meet's chat box and send it. Runs only when the
   * person presses the button in the extension's popup; never on its own.
   * Answers 'sent', or 'no_chat' when the chat panel is not open.
   */
  function postToChat(doc, text) {
    var input = first(doc, SELECTORS.chatInput);
    if (!input) return 'no_chat';
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      var proto = Object.getPrototypeOf(input);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, text);
      else input.value = text;
    } else {
      input.textContent = text;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var send = first(doc, SELECTORS.chatSend);
    if (send && !send.disabled) {
      send.click();
    } else {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
      );
    }
    return 'sent';
  }

  root.TipTopMeet = {
    CONSENT_NOTICE_TEXT: CONSENT_NOTICE_TEXT,
    EXTENSION_SOURCE: EXTENSION_SOURCE,
    PAGE_SOURCE: PAGE_SOURCE,
    BRIDGE_VERSION: BRIDGE_VERSION,
    SELECTORS: SELECTORS,
    cleanName: cleanName,
    readRoster: readRoster,
    RosterTracker: RosterTracker,
    shouldRelay: shouldRelay,
    postToChat: postToChat,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
