// Applies the saved theme before the page draws (no flash): "light", "dark", or none for the system's.
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (error) {}
})();
