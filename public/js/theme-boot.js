// Applies the saved light/dark mode before first paint, so there's no flash
// of the wrong theme. Loaded as a normal <script> in each page's <head>
// (rather than written inline) so the site's Content-Security-Policy can
// forbid inline scripts altogether.
(function () {
  try {
    var m = localStorage.getItem('r6sf_theme_mode');
    document.documentElement.dataset.theme = m === 'light' ? 'light' : 'dark';
  } catch (e) {}
})();
