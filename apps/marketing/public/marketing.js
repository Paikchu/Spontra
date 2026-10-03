(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton = document.getElementById('motion-toggle');
  let paused = reduced.matches;
  let observer;

  function showAll() {
    observer?.disconnect();
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
  }

  function updateMotion() {
    document.body.classList.toggle('motion-paused', paused);
    document.documentElement.style.scrollBehavior = paused ? 'auto' : '';
    if (paused) showAll();
    if (motionButton) {
      motionButton.setAttribute('aria-pressed', String(paused));
      motionButton.textContent = reduced.matches ? motionButton.dataset.reduced : paused ? motionButton.dataset.resume : motionButton.dataset.pause;
      motionButton.disabled = reduced.matches;
    }
  }

  if (!reduced.matches && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach(el => {
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-visible');
      else observer.observe(el);
    });
    document.body.classList.add('motion-ready');
  } else showAll();

  motionButton?.addEventListener('click', () => { paused = !paused; updateMotion(); });
  reduced.addEventListener('change', () => { paused = reduced.matches; updateMotion(); });
  updateMotion();

  function revealAnchor() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id && document.getElementById(id);
    if (target) {
      target.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));
      if (target.classList.contains('reveal')) target.classList.add('is-visible');
    }
  }
  revealAnchor();
  window.addEventListener('hashchange', revealAnchor);
  document.querySelectorAll('[data-language-switch]').forEach(link => {
    link.addEventListener('click', () => {
      const hash = window.location.hash;
      if (hash) link.href = new URL(link.getAttribute('href').split('#')[0] + hash, window.location.href).href;
    });
  });
})();
