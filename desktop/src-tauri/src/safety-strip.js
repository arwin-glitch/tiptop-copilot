// The main window's safety-net bar (frame.rs). The window has no title bar of
// its own, so a page on the live host that does not draw the real one (a host
// error page, the offline page, whose scripts are not cached, or a web deploy
// older than this app) gets this plain bar a few seconds in: it drags the
// window and, on Windows, has the menu and minimise, maximise and close. It
// steps aside as soon as the real bar is ready. A real bar that is on screen
// but still waiting for its scripts (a slow start) gets until a few seconds
// after the page has loaded, so the plain bar does not flash over it.
//
// Plain ES5 and CSP-safe: elements and CSSOM only, never HTML strings or
// style attributes. Dragging is Tauri's own data-tauri-drag-region script,
// not CSS app-region, so this last resort works whatever WebView2 does with
// non-client regions.
(function () {
  if (
    location.protocol !== 'https:' ||
    location.hostname !== 'copilot.tiptop.vc' ||
    window.top !== window
  )
    return;

  var FRAME = '__FRAME__';
  var HEIGHT = 40;
  var HOVER = 'rgba(255,255,255,0.08)';
  // Windows 11's close-button red.
  var CLOSE_HOVER = '#c42b1c';
  var SVG = 'http://www.w3.org/2000/svg';
  // The window buttons' glyphs are those of src/components/desktop/window-glyphs.tsx.
  // The menu's three lines are MenuGlyph's: 1px, on whole pixels.
  var GLYPHS = {
    menu: [['path', { d: 'M2 3.5h12M2 7.5h12M2 11.5h12' }]],
    minimise: [['path', { d: 'M0 5.5h10' }]],
    maximise: [['rect', { x: '0.5', y: '0.5', width: '9', height: '9', rx: '1' }]],
    restore: [
      ['rect', { x: '0.5', y: '2.5', width: '7', height: '7', rx: '1' }],
      ['path', { d: 'M2.5 2.5V0.5h7v7h-2' }],
    ],
    exitFullScreen: [['path', { d: 'M3.5 0.5v3h-3M6.5 0.5v3h3M3.5 9.5v-3h-3M6.5 9.5v-3h3' }]],
    close: [['path', { d: 'M0.5 0.5l9 9M9.5 0.5l-9 9', 'shape-rendering': 'geometricPrecision' }]],
  };

  var strip = null;
  var maxButton = null;
  var state = { maximized: false, fullscreen: false };
  var paddingBefore = null;
  var resizeTimer = 0;
  var startedAt = Date.now();
  var loadedAt = 0;
  var watcher = null;
  // How long after the page has loaded a real bar on screen may take to get
  // ready (its scripts start and the shell first answers) before this one
  // stands in for it (the offline page's never does), and the most it is
  // ever waited for, even on a page that never finishes loading.
  var READY_GRACE = 3000;
  var LONGEST_WAIT = 15000;

  function invoke(cmd, args) {
    try {
      var internals = window.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') {
        return Promise.resolve(internals.invoke(cmd, args || {})).then(null, function () {
          return null;
        });
      }
    } catch (_) {}
    return Promise.resolve(null);
  }

  function visible(selector) {
    var el = document.querySelector(selector);
    return !!el && el.offsetHeight > 0;
  }

  function background() {
    // --bg-sidebar in src/app/globals.css: the dark theme's, else the light theme's.
    return document.documentElement.classList.contains('dark') ? '#121413' : '#153e31';
  }

  function glyph(name) {
    // The menu's three lines are 16px, the window buttons' glyphs 10px, all
    // with 1px strokes on whole pixels, as Windows draws them.
    var size = name === 'menu' ? '16' : '10';
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var parts = GLYPHS[name];
    for (var i = 0; i < parts.length; i++) {
      var part = document.createElementNS(SVG, parts[i][0]);
      for (var key in parts[i][1]) part.setAttribute(key, parts[i][1][key]);
      svg.appendChild(part);
    }
    return svg;
  }

  function button(label, name, width, hover, onClick) {
    var el = document.createElement('button');
    el.type = 'button';
    // Like the system's own window buttons, none is a Tab stop; Alt+F4 still
    // closes the window.
    el.tabIndex = -1;
    el.setAttribute('aria-label', label);
    el.title = label;
    el.style.cssText = [
      'all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;',
      'flex:none;height:100%;color:inherit;cursor:default;pointer-events:auto;',
      'width:' + width + 'px;',
    ].join('');
    el.appendChild(glyph(name));
    el.addEventListener('mouseenter', function () {
      el.style.background = hover;
      if (hover === CLOSE_HOVER) el.style.color = '#ffffff';
    });
    el.addEventListener('mouseleave', function () {
      el.style.background = 'transparent';
      el.style.color = 'inherit';
    });
    // Keeps the page's focus, so the menu's Edit items act on the field in use.
    el.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    el.addEventListener('click', onClick);
    return el;
  }

  function paint() {
    if (!strip) return;
    // Never dragged, or maximised by a double-click, in full screen.
    strip.setAttribute('data-tauri-drag-region', state.fullscreen ? 'false' : 'deep');
    strip.style.background = background();
    if (!maxButton) return;
    var next = state.fullscreen
      ? ['Exit full screen', 'exitFullScreen']
      : state.maximized
        ? ['Restore', 'restore']
        : ['Maximise', 'maximise'];
    maxButton.setAttribute('aria-label', next[0]);
    maxButton.title = next[0];
    maxButton.replaceChild(glyph(next[1]), maxButton.firstChild);
  }

  function refresh() {
    if (!strip) return;
    invoke('window_frame').then(function (frame) {
      if (!frame || typeof frame !== 'object') return;
      state.maximized = frame.maximized === true;
      state.fullscreen = frame.fullscreen === true;
      paint();
    });
  }

  function control(action) {
    invoke('window_control', { action: action }).then(refresh);
  }

  // Told on the press and asked for on the click: the shell opens the menu
  // for a click only if it saw the press on the button while Windows still
  // reported the mouse button down, which a script cannot fake.
  function askForMenu(event) {
    if (event.button !== 0) return;
    var left = Math.round(event.currentTarget.getBoundingClientRect().left);
    invoke('show_app_menu', { x: left, y: HEIGHT });
  }

  function minimise() {
    control('minimize');
  }

  function maximise() {
    control(state.fullscreen ? 'exit-full-screen' : 'toggle-maximize');
  }

  function close() {
    control('close');
  }

  function build() {
    strip = document.createElement('div');
    strip.setAttribute('data-titlebar-fallback', '');
    strip.setAttribute('data-tauri-drag-region', 'deep');
    strip.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:2147483647;',
      'display:flex;align-items:center;margin:0;padding:0;box-sizing:border-box;',
      'color:#eee8d6;pointer-events:auto;user-select:none;-webkit-user-select:none;',
      'height:' + HEIGHT + 'px;',
    ].join('');
    if (FRAME === 'windows') {
      var menu = button('Menu', 'menu', 36, HOVER, askForMenu);
      menu.addEventListener('mousedown', askForMenu);
      menu.setAttribute('aria-haspopup', 'menu');
      menu.style.height = '28px';
      menu.style.marginLeft = '6px';
      menu.style.borderRadius = '6px';
      var spacer = document.createElement('div');
      spacer.style.cssText = 'flex:1 1 auto;align-self:stretch;';
      maxButton = button('Maximise', 'maximise', 46, HOVER, maximise);
      strip.appendChild(menu);
      strip.appendChild(spacer);
      strip.appendChild(button('Minimise', 'minimise', 46, HOVER, minimise));
      strip.appendChild(maxButton);
      strip.appendChild(button('Close window', 'close', 46, CLOSE_HOVER, close));
    }
    paint();
  }

  function show() {
    if (!strip) build();
    if (document.documentElement.contains(strip)) return;
    document.body.appendChild(strip);
    // Steps aside the moment the real bar says it is ready, not at the next check.
    if (!watcher && typeof MutationObserver === 'function') {
      watcher = new MutationObserver(check);
      watcher.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['data-titlebar-ready'],
      });
    }
    // The offline page's own bar already keeps the space (its buttons are
    // dead without scripts); this one covers it.
    if (paddingBefore === null && !visible('[data-titlebar]')) {
      paddingBefore = document.body.style.paddingTop;
      document.body.style.paddingTop = HEIGHT + 'px';
    }
    refresh();
  }

  function hide() {
    if (watcher) watcher.disconnect();
    watcher = null;
    if (!strip) return;
    if (strip.parentNode) strip.parentNode.removeChild(strip);
    if (paddingBefore !== null && document.body) document.body.style.paddingTop = paddingBefore;
    paddingBefore = null;
  }

  function check() {
    try {
      if (visible('[data-titlebar][data-titlebar-ready]')) return hide();
      if (!document.body) return;
      // The real bar is there, waiting for its scripts: let it finish.
      var now = Date.now();
      var waiting =
        visible('[data-titlebar]') &&
        !(strip && strip.parentNode) &&
        now - startedAt < LONGEST_WAIT &&
        (!loadedAt || now - loadedAt < READY_GRACE);
      if (waiting) return;
      show();
    } catch (_) {}
  }

  addEventListener('load', function () {
    loadedAt = Date.now();
  });

  addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refresh, 150);
  });

  // From the start, not from DOMContentLoaded, so a page that stalls while
  // loading gets a bar too.
  setTimeout(function () {
    check();
    setInterval(check, 2000);
  }, 4000);
})();
