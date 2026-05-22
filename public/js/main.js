// Row selection
document.addEventListener('click', function(e) {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const table = row.closest('table');
  table.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  const id = row.dataset.id;
  // Track selected ID only for main browse tables, not lookup modals
  if (!e.target.closest('.modal-lookup')) window._selectedId = id;
  document.querySelectorAll('[data-requires-selection]').forEach(btn => btn.disabled = false);
  document.querySelectorAll('[data-selected-id]').forEach(el => el.value = id);
  // store all row data for edit
  window._selectedRow = {};
  row.querySelectorAll('td[data-field]').forEach(td => {
    window._selectedRow[td.dataset.field] = td.dataset.value ?? td.textContent.trim();
  });
});

// Double-click to edit
document.addEventListener('dblclick', function(e) {
  const row = e.target.closest('tr[data-id]');
  if (!row || e.target.closest('.modal-lookup')) return;
  if (typeof openEdit === 'function') openEdit();
});

// Sidebar toggle (mobile)
const toggleBtn = document.getElementById('sidebarToggle');
if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('show');
  });
}

// Sidebar accordion
(function () {
  const groups = document.querySelectorAll('.sidebar-group');

  // Restore saved state; always expand group that contains the active link
  groups.forEach(group => {
    const key = 'tlc_sidebar_' + group.dataset.group;
    const saved = localStorage.getItem(key);
    const hasActive = !!group.querySelector('.sidebar-link.active');
    if (hasActive || saved === '1') group.classList.add('open');
  });

  // Toggle on header click
  groups.forEach(group => {
    const toggle = group.querySelector('.sidebar-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      group.classList.toggle('open');
      localStorage.setItem(
        'tlc_sidebar_' + group.dataset.group,
        group.classList.contains('open') ? '1' : '0'
      );
    });
  });
})();

// Search debounce helper
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Generic browse search
function initBrowse(options) {
  const { searchInput, searchColumn, tableBody, paginationEl, infoEl, pageSize = 20, fetchUrl } = options;
  let currentPage = 1;
  let currentSort = '';
  let currentDir = 'asc';

  function load() {
    const q = searchInput ? searchInput.value : '';
    const col = searchColumn ? searchColumn.value : '';
    const url = `${fetchUrl}?page=${currentPage}&q=${encodeURIComponent(q)}&col=${encodeURIComponent(col)}&sort=${currentSort}&dir=${currentDir}`;
    fetch(url)
      .then(r => r.json())
      .then(data => {
        const prevId = window._selectedId || null;
        tableBody.innerHTML = data.rows;
        if (infoEl) infoEl.textContent = `Página ${data.page} de ${data.totalPages} — ${data.total} registros`;
        if (paginationEl) {
          paginationEl.querySelector('[data-action=prev]').disabled = data.page <= 1;
          paginationEl.querySelector('[data-action=next]').disabled = data.page >= data.totalPages;
        }
        // Restore row highlight if the selected row is still visible on this page
        const restoredRow = prevId ? tableBody.querySelector(`tr[data-id="${prevId}"]`) : null;
        if (restoredRow) {
          restoredRow.classList.add('selected');
          window._selectedRow = {};
          restoredRow.querySelectorAll('td[data-field]').forEach(td => {
            window._selectedRow[td.dataset.field] = td.dataset.value ?? td.textContent.trim();
          });
        } else {
          window._selectedRow = null;
          window._selectedId = null;
          document.querySelectorAll('[data-requires-selection]').forEach(b => b.disabled = true);
        }
      });
  }

  if (searchInput) searchInput.addEventListener('input', debounce(() => { currentPage = 1; load(); }, 300));

  if (paginationEl) {
    paginationEl.querySelector('[data-action=prev]').addEventListener('click', () => { if (currentPage > 1) { currentPage--; load(); } });
    paginationEl.querySelector('[data-action=next]').addEventListener('click', () => { currentPage++; load(); });
  }

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      if (currentSort === th.dataset.sort) currentDir = currentDir === 'asc' ? 'desc' : 'asc';
      else { currentSort = th.dataset.sort; currentDir = 'asc'; }
      document.querySelectorAll('th[data-sort]').forEach(h => h.querySelector('.sort-icon') && (h.querySelector('.sort-icon').textContent = ''));
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = currentDir === 'asc' ? ' ▲' : ' ▼';
      currentPage = 1; load();
    });
  });

  load();
  return { load };
}

// Lookup helper
function openLookup(modalId, onSelect) {
  const modal = new bootstrap.Modal(document.getElementById(modalId));
  modal.show();
  document.getElementById(modalId).addEventListener('click', function handler(e) {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    onSelect(row);
    modal.hide();
    document.getElementById(modalId).removeEventListener('click', handler);
  }, { once: false });
}
