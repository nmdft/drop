(() => {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem('drop-theme'); } catch {}

  function apply(theme) {
    root.dataset.theme = theme;
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.setAttribute('aria-label', theme === 'dark' ? '切换浅色模式' : '切换深色模式');
      button.title = button.getAttribute('aria-label');
    }
  }

  const preferred = () => preference === 'dark' || preference === 'light' ? preference : system.matches ? 'dark' : 'light';
  apply(preferred());
  system.addEventListener('change', () => apply(preferred()));
  document.addEventListener('DOMContentLoaded', () => {
    apply(preferred());
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('drop-theme', preference); } catch {}
      apply(preference);
    });
  });
})();
