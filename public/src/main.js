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
