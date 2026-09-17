/* Admin behaviour: live table filter, delete confirmation dialog, JSON API deletes, copy-to-clipboard. */
(function () {
  'use strict';

  // ---- live search / filter ----------------------------------------------------
  var filterInput = document.querySelector('[data-filter]');
  if (filterInput) {
    var table = document.querySelector(filterInput.getAttribute('data-filter'));
    var rows = table ? Array.prototype.slice.call(table.querySelectorAll('tbody tr[data-search]')) : [];
    var noMatch = table ? table.querySelector('[data-no-match]') : null;
    var apply = function () {
      var needle = filterInput.value.trim().toLowerCase();
      var visible = 0;
      rows.forEach(function (row) {
        var show = !needle || row.getAttribute('data-search').indexOf(needle) !== -1;
        row.classList.toggle('hidden', !show);
        if (show) visible++;
      });
      if (noMatch) noMatch.classList.toggle('hidden', visible > 0 || rows.length === 0);
    };
    filterInput.addEventListener('input', apply);
    // Enter should not reload the page when JS filtering is active.
    filterInput.form && filterInput.form.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
    apply();
  }

  // ---- confirmation dialog for destructive forms --------------------------------
  var dialog = document.getElementById('confirm-dialog');
  var pending = null;
  function closeDialog() {
    pending = null;
    if (dialog && dialog.open) dialog.close();
  }
  function csrfOf(form) {
    var field = form.querySelector('input[name="_csrf"]');
    return field ? field.value : '';
  }

  // Blacklist rows are removed through the JSON API (DELETE) when possible so
  // the page does not reload; other forms submit normally after confirmation.
  function performDelete(form) {
    var id = form.getAttribute('data-entry-id');
    if (!id || !window.fetch) {
      form.submit();
      return;
    }
    var button = form.querySelector('button');
    if (button) button.setAttribute('disabled', 'disabled');
    fetch('/admin/blacklist/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrfOf(form), accept: 'application/json' },
      credentials: 'same-origin'
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function () {
        var row = form.closest('tr');
        if (row) {
          row.classList.add('is-removing');
          setTimeout(function () {
            row.remove();
            var count = document.querySelector('.count');
            if (count) count.textContent = String(Math.max(0, Number(count.textContent) - 1));
            if (filterInput) filterInput.dispatchEvent(new Event('input'));
          }, 250);
        }
      })
      .catch(function () {
        // Fall back to the classic form submission (full page reload with a flash message).
        form.submit();
      });
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.hasAttribute || !form.hasAttribute('data-confirm')) return;
    if (form.__confirmed) return;
    event.preventDefault();
    var message = form.getAttribute('data-confirm') || 'Are you sure?';
    if (!dialog || typeof dialog.showModal !== 'function') {
      if (window.confirm(message)) {
        form.__confirmed = true;
        performDelete(form);
      }
      return;
    }
    pending = form;
    var text = dialog.querySelector('#confirm-text');
    if (text) text.textContent = message;
    dialog.showModal();
  });

  if (dialog) {
    var cancel = dialog.querySelector('[data-dialog-cancel]');
    var confirm = dialog.querySelector('[data-dialog-confirm]');
    if (cancel) cancel.addEventListener('click', closeDialog);
    if (confirm) {
      confirm.addEventListener('click', function () {
        var form = pending;
        closeDialog();
        if (form) {
          form.__confirmed = true;
          performDelete(form);
        }
      });
    }
    dialog.addEventListener('close', function () { pending = null; });
    dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDialog(); });
  }

  // ---- copy export value --------------------------------------------------------
  var copy = document.querySelector('[data-copy]');
  var source = document.querySelector('[data-copy-source]');
  if (copy && source) {
    copy.addEventListener('click', function () {
      var done = function () {
        var label = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = label; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(source.value).then(done, function () { source.select(); });
      } else {
        source.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
      }
    });
  }
})();
