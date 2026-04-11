(function() {
  const tabs = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.tab-view');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      views.forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const view = document.querySelector(`[data-tab-view="${target}"]`);
      if (view) view.classList.add('active');
    });
  });
})();
