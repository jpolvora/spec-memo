/**
 * spec-memo — Documentation & Showcase Interactive Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  initCopyButtons();
  initHostTabs();
  initToolFilter();
  initKeyboardShortcuts();
});

/**
 * 1. Copy-to-clipboard buttons with tooltip feedback
 */
function initCopyButtons() {
  const copyButtons = document.querySelectorAll('.copy-btn, .code-copy-btn');
  copyButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const textToCopy =
        btn.getAttribute('data-copy') ||
        btn.closest('.code-block-wrapper, .hero-quick-install, .host-pane')?.querySelector('pre, code')?.innerText;
      if (!textToCopy) return;

      try {
        await navigator.clipboard.writeText(textToCopy.trim());
        const origHtml = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg> Copied!
        `;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = origHtml;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    });
  });
}

/**
 * 2. Host Configuration Tab Switcher
 */
function initHostTabs() {
  const tabs = document.querySelectorAll('.host-tab');
  const panes = document.querySelectorAll('.host-pane');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetHost = tab.getAttribute('data-host');
      if (!targetHost) return;

      tabs.forEach((t) => t.classList.remove('active'));
      panes.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const activePane = document.querySelector(`.host-pane[data-host="${targetHost}"]`);
      if (activePane) {
        activePane.classList.add('active');
      }
    });
  });
}

/**
 * 3. Interactive Tool Catalog Search & Filtering
 */
function initToolFilter() {
  const searchInput = document.getElementById('tool-search');
  const filterPills = document.querySelectorAll('.filter-pill');
  const toolCards = document.querySelectorAll('.tool-card');
  const noResults = document.getElementById('no-tools-results');
  const countBadge = document.getElementById('tools-counter');

  let currentCategory = 'all';
  let searchQuery = '';

  function applyFilter() {
    let visibleCount = 0;
    const query = searchQuery.trim().toLowerCase();

    toolCards.forEach((card) => {
      const name = card.getAttribute('data-name')?.toLowerCase() || '';
      const desc = card.getAttribute('data-desc')?.toLowerCase() || '';
      const category = card.getAttribute('data-category') || '';
      const tags = card.getAttribute('data-tags')?.toLowerCase() || '';

      const matchesCategory = currentCategory === 'all' || category === currentCategory;
      const matchesSearch = !query || name.includes(query) || desc.includes(query) || tags.includes(query);

      if (matchesCategory && matchesSearch) {
        card.classList.remove('hidden');
        visibleCount++;
      } else {
        card.classList.add('hidden');
      }
    });

    if (countBadge) {
      countBadge.innerText = `${visibleCount} tools & commands`;
    }

    if (noResults) {
      if (visibleCount === 0) {
        noResults.classList.remove('hidden');
      } else {
        noResults.classList.add('hidden');
      }
    }
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      applyFilter();
    });
  }

  filterPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      filterPills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      currentCategory = pill.getAttribute('data-filter') || 'all';
      applyFilter();
    });
  });
}

/**
 * 4. Keyboard shortcuts ('/' to focus search)
 */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault();
      const searchInput = document.getElementById('tool-search');
      if (searchInput) {
        searchInput.focus();
        searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });
}
