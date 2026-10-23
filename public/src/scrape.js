// "مصادر خارجية" page -- runs the bundled Python sidecar (scraper_sidecar.py,
// built via PyInstaller for Windows in CI) locally on the admin's machine to
// pull a manga/manhwa from Mangalek or azora, or a novel from kolnovel. The
// cf_clearance token these sites require never touches the server (it gets
// banned there), so this is deliberately all client-side + sidecar process.
const API_BASE = 'https://despair-world.com';
const $$ = (id) => document.getElementById(id);

function getKey() { return localStorage.getItem('despair_uploader_key') || ''; }

function sidecarCmd(args) {
  return window.__TAURI__.shell.Command.sidecar('binaries/scraper-sidecar', args);
}

const SITE_KIND = { mangalek: 'manga', azora: 'manga', kolnovel: 'novel' };

$$('scrapeSite').addEventListener('change', () => {
  $$('scrapeCfRow').style.display = $$('scrapeSite').value === 'mangalek' ? 'flex' : 'none';
});
$$('scrapeCfRow').style.display = $$('scrapeSite').value === 'mangalek' ? 'flex' : 'none';
$$('scrapeCf').value = localStorage.getItem('despair_scrape_cf') || '';
$$('scrapeUa').value = localStorage.getItem('despair_scrape_ua') || '';
$$('scrapeCf').addEventListener('change', () => localStorage.setItem('despair_scrape_cf', $$('scrapeCf').value.trim()));
$$('scrapeUa').addEventListener('change', () => localStorage.setItem('despair_scrape_ua', $$('scrapeUa').value.trim()));

let lastInfo = null;
let lastSite = null;

$$('scrapeFetchBtn').addEventListener('click', async () => {
  const site = $$('scrapeSite').value;
  const url = $$('scrapeUrl').value.trim();
  const statusEl = $$('scrapeStatus');
  if (!url) return;
  statusEl.textContent = 'جارِ الجلب...'; statusEl.className = 'status';
  $$('scrapePreviewCard').style.display = 'none';
  try {
    const args = ['info', '--site', site, '--url', url];
    if (site === 'mangalek') {
      if ($$('scrapeCf').value.trim()) args.push('--cf', $$('scrapeCf').value.trim());
      if ($$('scrapeUa').value.trim()) args.push('--ua', $$('scrapeUa').value.trim());
    }
    const out = await sidecarCmd(args).execute();
    const line = (out.stdout || '').split('\n').find((l) => l.startsWith('INFO ') || l.startsWith('ERROR '));
    if (!line) throw new Error(out.stderr || 'لا توجد استجابة من السكريبت');
    if (line.startsWith('ERROR ')) throw new Error(line.slice(6));
    const data = JSON.parse(line.slice(5));
    lastInfo = data;
    lastSite = site;
    renderPreview(data, site);
    statusEl.textContent = 'تم الجلب ✓'; statusEl.className = 'status ok';
  } catch (err) {
    statusEl.textContent = `خطأ: ${err.message}`; statusEl.className = 'status err';
  }
});

function renderPreview(data, site) {
  $$('scrapePreviewCard').style.display = 'block';
  $$('scrapeTitle').textContent = data.title || 'بدون عنوان';
  $$('scrapeDesc').textContent = data.description || '';
  $$('scrapeMeta').textContent = [
    data.status, data.author, (data.genres || []).join('، '),
  ].filter(Boolean).join(' -- ');
  if (data.cover_url) {
    $$('scrapeCover').src = data.cover_url;
    $$('scrapeCover').style.display = 'block';
  } else {
    $$('scrapeCover').style.display = 'none';
  }

  const tableEl = $$('scrapeChapterTable');
  tableEl.innerHTML = (data.chapters || []).map((c, i) => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid #1f1f1f;font-size:12px">
      <input type="checkbox" class="scrape-ch-chk" data-num="${c.num}" style="width:auto" />
      <span>الفصل ${c.num} -- ${c.name || ''}</span>
    </label>
  `).join('') || '<p class="status">لا توجد فصول</p>';

  wireWorkPicker(site);
}

$$('scrapeRangeBtn').addEventListener('click', () => {
  const from = Number($$('scrapeRangeFrom').value);
  const to = Number($$('scrapeRangeTo').value);
  document.querySelectorAll('.scrape-ch-chk').forEach((chk) => {
    const n = Number(chk.dataset.num);
    chk.checked = n >= from && n <= to;
  });
});
$$('scrapeAllBtn').addEventListener('click', () => {
  document.querySelectorAll('.scrape-ch-chk').forEach((chk) => { chk.checked = true; });
});

function wireWorkPicker(site) {
  const worksUrl = SITE_KIND[site] === 'novel' ? '/api/cache/uploader/novel/works' : '/api/cache/uploader/manga/works';
  const searchEl = $$('scrapeWorkSearch');
  const resultsEl = $$('scrapeWorkResults');
  const hiddenEl = $$('scrapeWorkId');
  searchEl.value = ''; hiddenEl.value = ''; resultsEl.innerHTML = ''; resultsEl.classList.remove('show');
  let timer;
  searchEl.oninput = () => {
    clearTimeout(timer);
    hiddenEl.value = '';
    const q = searchEl.value.trim();
    if (!q) { resultsEl.classList.remove('show'); resultsEl.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const res = await fetch(`${API_BASE}${worksUrl}?q=${encodeURIComponent(q)}`, { headers: { 'X-Uploader-Key': getKey() } });
      const data = await res.json().catch(() => ({}));
      resultsEl.innerHTML = '';
      for (const w of data.works || []) {
        const row = document.createElement('div');
        row.className = 'work-pick';
        row.innerHTML = `<img src="${w.cover_url || ''}" /><div class="meta"><b>${w.title_ar || w.title_en || w.id}</b><small>${w.id}</small></div>`;
        row.addEventListener('click', () => {
          hiddenEl.value = w.id;
          searchEl.value = w.title_ar || w.title_en || w.id;
          resultsEl.classList.remove('show');
        });
        resultsEl.appendChild(row);
      }
      resultsEl.classList.toggle('show', (data.works || []).length > 0);
    }, 350);
  };
}

async function ensureWorkId(site, info) {
  const existing = $$('scrapeWorkId').value.trim();
  if (existing) return existing;

  const kind = SITE_KIND[site];
  let synopsisAr = info.description || '';
  let genres = [];
  try {
    const translated = await (await fetch(`${API_BASE}/api/cache/uploader/translate-work-fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Uploader-Key': getKey() },
      body: JSON.stringify({ synopsis: info.description || '', genres: info.genres || [] }),
    })).json();
    if (translated.ok) { synopsisAr = translated.synopsisAr || synopsisAr; genres = translated.genres || []; }
  } catch { /* best effort -- fall back to raw description, no genres */ }

  const createUrl = kind === 'novel' ? '/api/cache/uploader/novel/work' : '/api/cache/uploader/manga/work';
  const payload = {
    title_ar: info.title,
    title_en: info.title,
    cover_url: info.cover_url || '',
    author_or_studio: info.author || '',
    status: info.status || 'مستمر',
    genres,
    synopsis: synopsisAr,
  };
  const res = await fetch(`${API_BASE}${createUrl}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Uploader-Key': getKey() },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok && !data.id) throw new Error(data.error || 'فشل إنشاء العمل');
  return data.id;
}

$$('scrapeDownloadBtn').addEventListener('click', async () => {
  if (!lastInfo || !lastSite) return;
  const selected = Array.from(document.querySelectorAll('.scrape-ch-chk:checked')).map((c) => c.dataset.num);
  const progressEl = $$('scrapeProgress');
  progressEl.style.display = 'block';
  if (selected.length === 0) {
    progressEl.innerHTML = '<div class="zpf" style="color:#f87171">اختر فصلًا واحدًا على الأقل</div>';
    return;
  }
  progressEl.innerHTML = '<div class="zpf">جارِ تجهيز العمل...</div>';
  try {
    const workId = await ensureWorkId(lastSite, lastInfo);
    const kind = SITE_KIND[lastSite];
    const startNum = $$('scrapeStartNum').value.trim();
    const qs = new URLSearchParams({ work_id: workId });
    if (startNum) qs.set('start_chapter_number', startNum);
    const uploadUrl = `${API_BASE}${kind === 'novel' ? '/api/cache/uploader/novel/chapters-zip' : '/api/cache/uploader/manga/chapter-zip'}?${qs}`;

    const args = [
      'download', '--site', lastSite, '--url', $$('scrapeUrl').value.trim(),
      '--chapters', selected.join(','),
      '--upload-url', uploadUrl, '--api-key', getKey(),
    ];
    if (lastSite === 'mangalek') {
      if ($$('scrapeCf').value.trim()) args.push('--cf', $$('scrapeCf').value.trim());
      if ($$('scrapeUa').value.trim()) args.push('--ua', $$('scrapeUa').value.trim());
    }

    const command = sidecarCmd(args);
    progressEl.innerHTML = `<div class="zpf">0 / ${selected.length} فصل</div>`;
    command.stdout.on('data', (line) => {
      if (line.startsWith('PROGRESS ')) {
        const [, done, total, ...label] = line.slice(9).trim().split(' ');
        progressEl.innerHTML = `<div class="zpf">${done} / ${total} فصل -- ${label.join(' ')}</div>`;
      } else if (line.startsWith('UPLOADING')) {
        progressEl.innerHTML += '<div class="zpc"><span>جارِ رفع الملف للموقع...</span></div>';
      }
    });
    const child = await command.spawn();
    const result = await new Promise((resolve, reject) => {
      command.on('close', (data) => resolve(data));
      command.on('error', (e) => reject(new Error(String(e))));
    });
    // Re-read full stdout isn't available from the close event in all
    // tauri-plugin-shell versions, so re-run a lightweight parse via the
    // last captured line through the data listener above would be ideal;
    // we fall back to checking the exit code here.
    if (result.code !== 0) {
      progressEl.innerHTML += '<div class="zpf" style="color:#f87171">فشل الرفع -- راجع الاتصال أو الـ cf_clearance</div>';
    } else {
      progressEl.innerHTML += '<div class="zpf" style="color:#4ade80">تم الرفع ✓</div>';
    }
  } catch (err) {
    progressEl.innerHTML += `<div class="zpf" style="color:#f87171">خطأ: ${err.message}</div>`;
  }
});
