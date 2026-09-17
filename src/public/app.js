/* Site behaviour: theme toggle, homepage validation + loading state, back button. */
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

  // ---- homepage search form -------------------------------------------------
  var form = document.getElementById('open-form');
  if (!form) return;
  var input = document.getElementById('url');
  var button = document.getElementById('open-button');
  var errorBox = document.getElementById('form-error');
  var box = form.querySelector('.search-box');

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

  input.addEventListener('input', clearError);

  form.addEventListener('submit', function (event) {
    var value = input.value.trim();
    if (!value) {
      event.preventDefault();
      showError('Please enter a website or URL.');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
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
    input.value = value;
    setBusy(true);
  });

  // Restore the form when the user navigates back to this page (bfcache).
  window.addEventListener('pageshow', function () {
    setBusy(false);
  });
})();
