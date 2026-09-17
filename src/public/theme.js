/* Applies the saved theme before first paint (loaded synchronously in <head>). */
(function () {
  try {
    var saved = localStorage.getItem('anonview-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    /* storage unavailable: follow the system preference */
  }
})();
