/* Homepage behaviour: client-side validation + loading indicator. */
(function () {
  'use strict';
  var form = document.getElementById('open-form');
  if (!form) return;
  var input = document.getElementById('url');
  var button = document.getElementById('open-button');
  var errorBox = document.getElementById('form-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
    input.focus();
  }

  form.addEventListener('submit', function (event) {
    var value = input.value.trim();
    if (!value) {
      event.preventDefault();
      showError('Please enter a web address.');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
      event.preventDefault();
      showError('Only http:// and https:// addresses are supported.');
      return;
    }
    if (/^(https?:\/\/)?(\[[^\]]*\]|\d{1,3}(\.\d{1,3}){3})(:|\/|$)/i.test(value) || /^(https?:\/\/)?localhost(:|\/|$)/i.test(value)) {
      event.preventDefault();
      showError('IP addresses and local hosts are not supported. Enter a domain name from the allowlist.');
      return;
    }
    errorBox.classList.add('hidden');
    button.classList.add('is-loading');
    button.setAttribute('disabled', 'disabled');
    button.setAttribute('aria-busy', 'true');
    // Re-enable if the user navigates back to this page (bfcache).
    window.addEventListener('pageshow', function () {
      button.classList.remove('is-loading');
      button.removeAttribute('disabled');
      button.removeAttribute('aria-busy');
    });
    // A disabled submit button is not included in the submission — that is fine, it has no name.
  });
})();
