// Despair uploader app -- deliberately plain JS, no framework: the Tauri
// webview is a real browser engine, so <input type="file"> + fetch() work
// exactly like they would in a normal web page. All business logic
// (validation, multi-chapter zip splitting, etc.) already lives server-side
// (server/cache-api.mjs's /api/cache/uploader/* routes) -- this app is a
// thin client that picks files and calls those endpoints with the stored
// API key, nothing more.
const API_BASE = 'https://despair-world.com';

const $ = (id) => document.getElementById(id);

function getKey() {
  return localStorage.getItem('despair_uploader_key') || '';
}

async function apiFetch(path, options = {}) {
  const key = getKey();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'X-Uploader-Key': key,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// -------------------- Sidebar navigation --------------------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`page-${btn.dataset.page}`).classList.add('active');
  });
});

// -------------------- API key / connection status --------------------
function setConnStatus(connected, text) {
  const el = $('connStatus');
  el.className = connected ? 'ok' : 'err';
  $('connText').textContent = text;
}

function setKeyStatus(text, cls) {
  const el = $('keyStatus');
  el.textContent = text;
  el.className = `status ${cls || ''}`;
}

async function checkKey() {
  if (!getKey()) { setConnStatus(false, 'غير متصل'); setKeyStatus('لم يتم إدخال مفتاح بعد', ''); return; }
  try {
    const data = await apiFetch('/api/cache/uploader/whoami');
    const who = `${data.username || data.userId} (${data.isAdmin ? 'أدمن' : 'مساعد'})`;
    setConnStatus(true, who);
    setKeyStatus(`متصل كـ ${who}`, 'ok');
  } catch (err) {
    setConnStatus(false, 'مفتاح غير صالح');
    setKeyStatus(`المفتاح غير صالح: ${err.message}`, 'err');
  }
}

$('apiKey').value = getKey();
$('saveKeyBtn').addEventListener('click', () => {
  localStorage.setItem('despair_uploader_key', $('apiKey').value.trim());
  checkKey();
});
checkKey();

// -------------------- Generic multi-file queued upload --------------------
async function uploadQueue({ files, queueEl, buildUrl }) {
  queueEl.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.innerHTML = `<div class="top"><b>${file.name}</b><span class="st">جارِ الرفع...</span></div><small>${(file.size / 1024 / 1024).toFixed(1)} MB</small>`;
    queueEl.appendChild(row);
    const stEl = row.querySelector('.st');
    try {
      const data = await apiFetch(buildUrl(file), {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const chapters = data.chapters || [];
      const okCount = chapters.filter((c) => c.success).length;
      stEl.textContent = `✓ ${okCount}/${chapters.length} فصل`;
      stEl.style.color = '#4ade80';
    } catch (err) {
      stEl.textContent = `✗ ${err.message}`;
      stEl.style.color = '#f87171';
    }
  }
}

// -------------------- Manga --------------------
$('mangaUploadBtn').addEventListener('click', async () => {
  const workId = $('mangaWorkId').value.trim();
  const startNum = $('mangaStartNum').value.trim();
  const files = Array.from($('mangaZipFiles').files);
  if (!workId || files.length === 0) return alert('حدد معرّف العمل واختر ملف zip واحد على الأقل');
  await uploadQueue({
    files,
    queueEl: $('mangaQueue'),
    buildUrl: () => {
      const qs = new URLSearchParams({ work_id: workId });
      if (startNum) qs.set('start_chapter_number', startNum);
      return `/api/cache/uploader/manga/chapter-zip?${qs}`;
    },
  });
});

// -------------------- Novel --------------------
$('novelUploadBtn').addEventListener('click', async () => {
  const workId = $('novelWorkId').value.trim();
  const startNum = $('novelStartNum').value.trim();
  const files = Array.from($('novelZipFiles').files);
  if (!workId || files.length === 0) return alert('حدد معرّف العمل واختر ملف zip واحد على الأقل');
  await uploadQueue({
    files,
    queueEl: $('novelQueue'),
    buildUrl: () => {
      const qs = new URLSearchParams({ work_id: workId });
      if (startNum) qs.set('start_chapter_number', startNum);
      return `/api/cache/uploader/novel/chapters-zip?${qs}`;
    },
  });
});

// -------------------- Anime / AniList --------------------
$('anilistSearchBtn').addEventListener('click', async () => {
  const q = $('anilistQuery').value.trim();
  const resultsEl = $('anilistResults');
  if (!q) return;
  resultsEl.innerHTML = '<p class="status">جارِ البحث...</p>';
  try {
    const data = await apiFetch(`/api/cache/uploader/anime/anilist-search?q=${encodeURIComponent(q)}`);
    resultsEl.innerHTML = '';
    for (const r of data.results || []) {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.innerHTML = `
        <div class="top">
          <b>${r.titleRomaji}</b>
          <button class="secondary small create-btn">إنشاء</button>
        </div>
        <small>${r.releaseYear || ''} -- ${r.episodesCount || '?'} حلقة -- ${r.genres.join('، ')}</small>
      `;
      row.querySelector('.create-btn').addEventListener('click', async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'جارِ الإنشاء...';
        try {
          const created = await apiFetch('/api/cache/uploader/anime/anilist-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              anilistId: r.anilistId,
              titleRomaji: r.titleRomaji,
              titleEnglish: r.titleEnglish,
              coverUrl: r.coverUrl,
              descriptionEn: r.descriptionEn,
              genres: r.genres,
              tags: r.tags,
              status: r.status,
              releaseYear: r.releaseYear,
              studio: r.studio,
            }),
          });
          e.target.textContent = `تم (${created.id})`;
        } catch (err) {
          e.target.textContent = `خطأ: ${err.message}`;
          e.target.disabled = false;
        }
      });
      resultsEl.appendChild(row);
    }
    if ((data.results || []).length === 0) resultsEl.innerHTML = '<p class="status">لا توجد نتائج</p>';
  } catch (err) {
    resultsEl.innerHTML = `<p class="status err">خطأ: ${err.message}</p>`;
  }
});

// -------------------- Generic work manager (manga/novel/anime) --------------------
// One implementation covers all three content types -- search a work, pick
// it, see its chapters/episodes, select a range or individual rows, then
// bulk-delete or bulk-transfer-to-another-team in one call. `cfg` supplies
// the type-specific endpoint paths and field names.
let teamsCache = null;
async function getTeams() {
  if (teamsCache) return teamsCache;
  try {
    const data = await apiFetch('/api/cache/uploader/teams');
    teamsCache = data.teams || [];
  } catch {
    teamsCache = [];
  }
  return teamsCache;
}

function renderWorkManager(containerId, cfg) {
  const root = $(containerId);
  let selectedWork = null;
  let items = []; // chapters or episodes
  let checked = new Set();

  root.innerHTML = `
    <div class="card">
      <h2>🔍 بحث عن ${cfg.label}</h2>
      <input id="${containerId}-search" placeholder="ابحث بالاسم..." />
      <div id="${containerId}-results"></div>
    </div>
    <div class="card" id="${containerId}-detail" style="display:none"></div>
  `;

  const searchInput = $(`${containerId}-search`);
  const resultsEl = $(`${containerId}-results`);
  const detailEl = $(`${containerId}-detail`);

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 350);
  });

  async function doSearch() {
    const q = searchInput.value.trim();
    resultsEl.innerHTML = '<p class="status">جارِ البحث...</p>';
    try {
      const data = await apiFetch(`${cfg.worksUrl}?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = '';
      for (const w of data.works || []) {
        const row = document.createElement('div');
        row.className = 'work-pick';
        row.innerHTML = `<img src="${w.cover_url || ''}" /><div class="meta"><b>${w.title_ar}</b><small>${w[cfg.countField] || 0} ${cfg.itemLabel}</small></div>`;
        row.addEventListener('click', () => selectWork(w));
        resultsEl.appendChild(row);
      }
      if ((data.works || []).length === 0) resultsEl.innerHTML = '<p class="status">لا نتائج</p>';
    } catch (err) {
      resultsEl.innerHTML = `<p class="status err">${err.message}</p>`;
    }
  }
  doSearch();

  async function selectWork(w) {
    selectedWork = w;
    checked = new Set();
    detailEl.style.display = 'block';
    detailEl.innerHTML = `
      <div class="selected-work">
        <img src="${w.cover_url || ''}" />
        <div class="meta"><b>${w.title_ar}</b></div>
        <button class="secondary small" id="${containerId}-close">إغلاق</button>
      </div>
      <div class="bulk-bar">
        <span>تحديد نطاق:</span>
        <input id="${containerId}-rangeFrom" type="number" placeholder="من" style="width:70px" />
        <input id="${containerId}-rangeTo" type="number" placeholder="إلى" style="width:70px" />
        <button class="secondary small" id="${containerId}-selectRange">تحديد</button>
        <span style="flex:1"></span>
        <select id="${containerId}-teamSelect" style="width:160px"><option value="">بدون فريق</option></select>
        <button class="secondary small" id="${containerId}-transferBtn">نقل الملكية للمحدد</button>
        <button class="secondary small" id="${containerId}-deleteBtn" style="color:#f87171">حذف المحدد</button>
      </div>
      <div style="max-height:360px;overflow-y:auto">
        <table class="ch-table">
          <thead><tr><th></th><th>#</th><th>العنوان</th><th>الفريق</th></tr></thead>
          <tbody id="${containerId}-tbody"></tbody>
        </table>
      </div>
    `;
    $(`${containerId}-close`).addEventListener('click', () => { detailEl.style.display = 'none'; selectedWork = null; });
    $(`${containerId}-selectRange`).addEventListener('click', selectRange);
    $(`${containerId}-transferBtn`).addEventListener('click', doTransfer);
    $(`${containerId}-deleteBtn`).addEventListener('click', doDelete);

    const teamSelect = $(`${containerId}-teamSelect`);
    for (const t of await getTeams()) {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      teamSelect.appendChild(opt);
    }

    await loadItems();
  }

  async function loadItems() {
    const tbody = $(`${containerId}-tbody`);
    tbody.innerHTML = '<tr><td colspan="4">جارِ التحميل...</td></tr>';
    try {
      const data = await apiFetch(cfg.itemsUrl(selectedWork.id));
      items = data[cfg.itemsKey] || [];
      renderRows();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="status err">${err.message}</td></tr>`;
    }
  }

  function renderRows() {
    const tbody = $(`${containerId}-tbody`);
    tbody.innerHTML = '';
    for (const it of items) {
      const num = it[cfg.numberField];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" data-num="${num}" ${checked.has(num) ? 'checked' : ''} /></td>
        <td>${num}</td>
        <td>${it.title || ''}</td>
        <td>${it.team_id || '-'}</td>
      `;
      tr.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) checked.add(num); else checked.delete(num);
      });
      tbody.appendChild(tr);
    }
  }

  function selectRange() {
    const from = Number($(`${containerId}-rangeFrom`).value);
    const to = Number($(`${containerId}-rangeTo`).value);
    if (!from || !to) return;
    checked = new Set(items.filter((it) => it[cfg.numberField] >= from && it[cfg.numberField] <= to).map((it) => it[cfg.numberField]));
    renderRows();
  }

  async function doDelete() {
    if (checked.size === 0) return alert('حدد عناصر أولاً');
    if (!confirm(`متأكد من حذف ${checked.size} ${cfg.itemLabel}؟ لا يمكن التراجع.`)) return;
    const nums = [...checked];
    try {
      await apiFetch(cfg.bulkDeleteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [cfg.workIdField]: selectedWork.id, from: Math.min(...nums), to: Math.max(...nums) }),
      });
      await loadItems();
    } catch (err) {
      alert(`فشل الحذف: ${err.message}`);
    }
  }

  async function doTransfer() {
    if (checked.size === 0) return alert('حدد عناصر أولاً');
    const teamId = $(`${containerId}-teamSelect`).value || null;
    const nums = [...checked];
    try {
      await apiFetch(cfg.transferUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [cfg.workIdField]: selectedWork.id, from: Math.min(...nums), to: Math.max(...nums), team_id: teamId }),
      });
      await loadItems();
    } catch (err) {
      alert(`فشل النقل: ${err.message}`);
    }
  }
}

renderWorkManager('manga-manager', {
  label: 'عمل مانجا/مانهوا',
  itemLabel: 'فصل',
  countField: 'chapters_count',
  worksUrl: '/api/cache/uploader/manga/works',
  itemsUrl: (id) => `/api/cache/uploader/manga/works/${id}/chapters`,
  itemsKey: 'chapters',
  numberField: 'chapter_number',
  workIdField: 'work_id',
  bulkDeleteUrl: '/api/cache/uploader/manga/chapters/bulk-delete',
  transferUrl: '/api/cache/uploader/manga/chapters/transfer-team',
});

renderWorkManager('novel-manager', {
  label: 'رواية',
  itemLabel: 'فصل',
  countField: 'chapters_count',
  worksUrl: '/api/cache/uploader/novel/works',
  itemsUrl: (id) => `/api/cache/uploader/novel/works/${id}/chapters`,
  itemsKey: 'chapters',
  numberField: 'chapter_number',
  workIdField: 'work_id',
  bulkDeleteUrl: '/api/cache/uploader/novel/chapters/bulk-delete',
  transferUrl: '/api/cache/uploader/novel/chapters/transfer-team',
});

renderWorkManager('anime-manager', {
  label: 'عمل أنمي',
  itemLabel: 'حلقة',
  countField: 'episodes_count',
  worksUrl: '/api/cache/uploader/anime/works',
  itemsUrl: (id) => `/api/cache/uploader/anime/works/${id}/episodes`,
  itemsKey: 'episodes',
  numberField: 'episode_number',
  workIdField: 'anime_id',
  bulkDeleteUrl: '/api/cache/uploader/anime/episodes/bulk-delete',
  transferUrl: '/api/cache/uploader/anime/episodes/transfer-team',
});
