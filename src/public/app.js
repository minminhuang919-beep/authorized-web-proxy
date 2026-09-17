/* Site behaviour: theme toggle, search box (suggestions, keyboard navigation, loading state), back button. */
(function () {
  'use strict';

  // ---- theme toggle --------------------------------------------------------
  var root = document.documentElement;
  var toggle = document.querySelector('[data-theme-toggle]');
  function currentTheme() {
    var explicit = root.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem('anonview-theme', next);
      } catch (e) {
        /* ignore */
      }
    });
  }

  // ---- "go back" buttons on error pages -------------------------------------
  var back = document.querySelector('[data-back]');
  if (back) {
    back.addEventListener('click', function () {
      if (history.length > 1) history.back();
      else location.href = '/';
    });
  }

  // ---- search box -------------------------------------------------------------
  var form = document.getElementById('search-form');
  if (!form) return;
  var input = document.getElementById('q');
  var button = document.getElementById('search-button');
  var errorBox = document.getElementById('form-error');
  var box = form.querySelector('.search-box');
  var listbox = document.getElementById('suggestions');
  var searchEnabled = form.getAttribute('data-search-enabled') === '1';

  var progress = document.createElement('div');
  progress.className = 'progress';
  progress.setAttribute('aria-hidden', 'true');
  document.body.appendChild(progress);

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    box.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  function clearError() {
    errorBox.classList.add('hidden');
    box.classList.remove('has-error');
    input.removeAttribute('aria-invalid');
  }
  function setBusy(busy) {
    document.body.classList.toggle('is-busy', busy);
    button.classList.toggle('is-loading', busy);
    if (busy) {
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('disabled', 'disabled');
      input.setAttribute('readonly', 'readonly');
    } else {
      button.removeAttribute('aria-busy');
      button.removeAttribute('disabled');
      input.removeAttribute('readonly');
    }
  }

  // Clearly an address: a scheme, or a dotted host with an alphabetic
  // top-level label before any path (mirrors the server's classification).
  function looksLikeAddress(value) {
    if (/^(https?:|\/\/)/i.test(value)) return true;
    var authority = value.split(/[/?#]/)[0];
    return /^[^\s@]*@?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63}(:\d+)?$/i.test(authority);
  }

  // ---- suggestions (ARIA combobox) ---------------------------------------------
  var ICONS = {
    site: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  var cache = Object.create(null);
  var timer = null;
  var controller = null;
  var items = [];
  var active = -1;
  var open = false;
  var counter = 0;

  function close() {
    if (!open) return;
    open = false;
    active = -1;
    items = [];
    listbox.className = 'suggestions hidden';
    listbox.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function addItem(kind, primary, secondary, href) {
    var el = document.createElement('div');
    el.className = 'suggestion is-' + kind;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.id = 'suggestion-' + ++counter;
    var icon = document.createElement('span');
    icon.className = 'suggestion-icon';
    icon.innerHTML = ICONS[kind]; // static markup, never user text
    var text = document.createElement('span');
    text.className = 'suggestion-text';
    var p = document.createElement('span');
    p.className = 'suggestion-primary';
    p.textContent = primary;
    text.appendChild(p);
    if (secondary) {
      var s = document.createElement('span');
      s.className = 'suggestion-secondary';
      s.textContent = secondary;
      text.appendChild(s);
    }
    var kindLabel = document.createElement('span');
    kindLabel.className = 'suggestion-kind';
    kindLabel.textContent = kind === 'site' ? 'shortcut' : kind === 'open' ? 'website' : 'search';
    el.appendChild(icon);
    el.appendChild(text);
    el.appendChild(kindLabel);
    listbox.appendChild(el);
    items.push({ el: el, href: href });
  }

  function renderSuggestions(value, sites) {
    listbox.innerHTML = '';
    items = [];
    active = -1;
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      addItem('site', s.name, 'Shortcut: ' + s.shortcut + (s.host ? ' · ' + s.host : ''), '/search?q=' + encodeURIComponent(s.shortcut));
    }
    // Only something that clearly looks like an address gets an "Open" entry — a bare word never becomes a domain.
    if (looksLikeAddress(value)) addItem('open', 'Open ' + value, 'Website address', '/open?url=' + encodeURIComponent(value));
    if (searchEnabled) addItem('search', 'Search for “' + value + '”', '', '/search?q=' + encodeURIComponent(value) + '&mode=search');
    if (!items.length) {
      close();
      return;
    }
    open = true;
    listbox.className = 'suggestions';
    input.setAttribute('aria-expanded', 'true');
  }

  function fetchSuggestions(value) {
    var key = value.toLowerCase();
    if (cache[key]) {
      renderSuggestions(value, cache[key]);
      return;
    }
    if (!window.fetch || !window.AbortController) {
      renderSuggestions(value, []);
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    fetch('/suggest?q=' + encodeURIComponent(value), { signal: controller.signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.ok ? res.json() : { sites: [] };
      })
      .then(function (data) {
        var sites = (data && data.sites) || [];
        cache[key] = sites;
        if (input.value.trim() === value) renderSuggestions(value, sites);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (input.value.trim() === value) renderSuggestions(value, []);
      });
  }

  function setActive(index) {
    active = index;
    for (var i = 0; i < items.length; i++) {
      var on = i === index;
      items[i].el.classList.toggle('is-active', on);
      items[i].el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', items[index].el.id);
      if (items[index].el.scrollIntoView) items[index].el.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function go(href) {
    close();
    clearError();
    setBusy(true);
    location.assign(href);
  }

  input.addEventListener('input', function () {
    clearError();
    var value = input.value.trim();
    if (timer) clearTimeout(timer);
    if (!value || value.length > 100) {
      close();
      return;
    }
    timer = setTimeout(function () {
      fetchSuggestions(value);
    }, 120);
  });

  input.addEventListener('keydown', function (event) {
    if (!open) {
      if (event.key === 'ArrowDown' && input.value.trim()) fetchSuggestions(input.value.trim());
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((active + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (event.key === 'Enter') {
      if (active >= 0) {
        event.preventDefault();
        go(items[active].href);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      close();
    }
  });

  listbox.addEventListener('mousedown', function (event) {
    event.preventDefault(); // keep the input focused
  });
  listbox.addEventListener('click', function (event) {
    var el = event.target.closest ? event.target.closest('[role="option"]') : null;
    if (!el) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].el === el) {
        go(items[i].href);
        return;
      }
    }
  });
  listbox.addEventListener('mousemove', function (event) {
    var el = event.target.closest ? event.target.closest('[role="option"]') : null;
    if (!el) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].el === el && active !== i) setActive(i);
    }
  });
  document.addEventListener('click', function (event) {
    if (!form.contains(event.target)) close();
  });
  input.addEventListener('blur', function () {
    setTimeout(close, 150);
  });

  form.addEventListener('submit', function (event) {
    var value = input.value.trim();
    if (!value) {
      event.preventDefault();
      showError(searchEnabled ? 'Type a shortcut, a website or something to search for.' : 'Type a shortcut or a website address.');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) {
      event.preventDefault();
      showError('Only http:// and https:// addresses are supported.');
      return;
    }
    if (/^(https?:\/\/)?(\[[^\]]*\]|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(value) || /^(https?:\/\/)?localhost(:|\/|$)/i.test(value)) {
      event.preventDefault();
      showError('IP addresses and local hosts are not supported. Enter a website name.');
      return;
    }
    clearError();
    close();
    input.value = value;
    setBusy(true);
  });

  // Restore the form when the user navigates back to this page (bfcache).
  window.addEventListener('pageshow', function () {
    setBusy(false);
  });
})();
