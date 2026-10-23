"""
Despair uploader -- scraper sidecar.

One binary, three sites (mangalek, azora, kolnovel), two commands:

  info --site <site> --url <url> [--cf <cf_clearance>] [--ua <user_agent>]
      -> prints one line: INFO <json>
         json = {title, chapters:[{num, name}], cover_url, description, genres, status, author}

  download --site <site> --url <url> --chapters <range|all> --out <zip_path>
           [--cf <cf_clearance>] [--ua <user_agent>]
      -> prints progress lines: PROGRESS <done> <total> <label>
         and a final line: DONE <zip_path>   or   ERROR <message>

The output zip is built in the exact shape the app's existing
/api/cache/uploader/manga/chapter-zip and /novel/chapters-zip endpoints
already expect (one top-level folder per chapter for manga, one .txt file
per chapter for novels) -- so no new server code is needed, this sidecar
just needs to hand the app a zip it can POST as-is.

This runs entirely on the admin's own machine (invoked by the Tauri app as
a sidecar process) because the Cloudflare cf_clearance token these sites
require does not survive being used from the server (it gets banned).
"""
import argparse
import html
import json
import re
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

try:
    from curl_cffi import requests as cfreq
    HAVE_CURL_CFFI = True
except ImportError:
    HAVE_CURL_CFFI = False
import requests as plain_requests
from bs4 import BeautifulSoup


def make_session(ua):
    if HAVE_CURL_CFFI:
        s = cfreq.Session(impersonate="chrome")
    else:
        s = plain_requests.Session()
    s.headers["User-Agent"] = ua or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    )
    return s


def emit(kind, payload):
    if isinstance(payload, (dict, list)):
        print(f"{kind} {json.dumps(payload, ensure_ascii=False)}", flush=True)
    else:
        print(f"{kind} {payload}", flush=True)


def clean_filename(name):
    return re.sub(r'[\\/*?:"<>|]', "", name or "").strip()[:120] or "untitled"


def pick_range(sel, nums):
    """nums: list of numeric-string chapter numbers, already sorted."""
    if not sel or sel == "all":
        return nums
    out = []
    for part in sel.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            lo = float(a) if a else 0
            hi = float(b) if b else 1e9
            out += [n for n in nums if lo <= float(n) <= hi]
        elif part in nums:
            out.append(part)
    return sorted(set(out), key=float)


# ---------------------------------------------------------------- mangalek
def mangalek_headers(session, cf):
    headers = {"Referer": "https://mangalek.net/"}
    if cf:
        headers["Cookie"] = f"cf_clearance={cf}"
    return headers


def mangalek_get(session, url, headers, retries=3):
    for _ in range(retries):
        try:
            r = session.get(url, headers=headers, timeout=15)
            if r.status_code == 200:
                return r
        except Exception:
            pass
        time.sleep(2)
    return None


def mangalek_info(session, url, cf):
    headers = mangalek_headers(session, cf)
    r = mangalek_get(session, url, headers)
    if not r:
        raise RuntimeError("تعذر الوصول للصفحة -- تأكد من رابط العمل وصلاحية cf_clearance")
    soup = BeautifulSoup(r.text, "html.parser")
    title_el = soup.select_one("div.post-title h1") or soup.select_one("h1")
    title = clean_filename(title_el.text.strip()) if title_el else "Manga"
    desc_el = soup.select_one("div.summary__content") or soup.select_one("div.description-summary")
    description = desc_el.text.strip() if desc_el else ""
    cover_el = soup.select_one("div.summary_image img")
    cover_url = ""
    if cover_el:
        cover_url = (cover_el.get("data-src") or cover_el.get("src") or "").strip()
        if cover_url.startswith("//"):
            cover_url = "https:" + cover_url
    genres = [a.text.strip() for a in soup.select("div.genres-content a, div.manga-genres a")]
    status_el = soup.select_one("div.post-status div.summary-content")
    status = status_el.text.strip() if status_el else ""
    author_el = soup.select_one("div.author-content a")
    author = author_el.text.strip() if author_el else ""

    chapters = []
    for a in soup.select("li.wp-manga-chapter a"):
        link = a.get("href")
        name = clean_filename(a.text.strip())
        if link and link not in [c["link"] for c in chapters]:
            m = re.search(r"(\d+(?:\.\d+)?)", name)
            chapters.append({"link": link, "name": name, "num": m.group(1) if m else None})
    chapters.reverse()
    for i, c in enumerate(chapters, start=1):
        if c["num"] is None:
            c["num"] = str(i)

    return {
        "title": title, "description": description, "cover_url": cover_url,
        "genres": genres, "status": status, "author": author,
        "chapters": [{"num": c["num"], "name": c["name"]} for c in chapters],
        "_raw_chapters": chapters,
    }


def mangalek_images(session, url, headers):
    r = mangalek_get(session, url, headers)
    if not r:
        return []
    soup = BeautifulSoup(r.text, "html.parser")
    urls = []
    for img in soup.select("div.page-break img, div.reading-content img"):
        src = img.get("data-src") or img.get("src")
        if src:
            src = src.strip()
            if src.startswith("//"):
                src = "https:" + src
            urls.append(src)
    return urls


def mangalek_download(session, url, chapters_sel, out_path, cf):
    headers = mangalek_headers(session, cf)
    info = mangalek_info(session, url, cf)
    raw = info["_raw_chapters"]
    nums = [c["num"] for c in raw]
    todo_nums = pick_range(chapters_sel, nums)
    todo = [c for c in raw if c["num"] in todo_nums]
    total = len(todo)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, ch in enumerate(todo, start=1):
            emit("PROGRESS", f"{i - 1} {total} {ch['name']}")
            images = mangalek_images(session, ch["link"], headers)
            for idx, img_url in enumerate(images, start=1):
                r = mangalek_get(session, img_url, headers)
                if not r:
                    continue
                ext = img_url.split(".")[-1].split("?")[0]
                if len(ext) > 4 or not ext.isalnum():
                    ext = "jpg"
                zf.writestr(f"{ch['num']}/{idx:03d}.{ext}", r.content)
            emit("PROGRESS", f"{i} {total} {ch['name']}")


# -------------------------------------------------------------------- azora
def azora_base_slug(url):
    u = urlparse(url)
    base = f"{u.scheme}://{u.netloc}"
    m = re.search(r"/series/([^/]+)", u.path)
    if not m:
        raise RuntimeError("رابط أزورا غير صالح")
    return base, m.group(1)


def azora_page(session, url):
    for i in range(4):
        try:
            r = session.get(url, timeout=40)
            if r.status_code == 200:
                return html.unescape(r.text.replace("\\/", "/").replace('\\"', '"'))
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(f"فشل تحميل {url}")


def azora_info(session, url):
    base, slug = azora_base_slug(url)
    h = azora_page(session, f"{base}/series/{slug}")
    t = re.search(r"<h1[^>]*>(.*?)</h1>", h, re.S)
    title = clean_filename(re.sub(r"<[^>]+>", "", t.group(1)).strip()) if t else slug
    nums = sorted(set(re.findall(rf"/series/{re.escape(slug)}/chapter-([\d.]+)", h)), key=float)
    return {
        "title": title, "description": "", "cover_url": "", "genres": [], "status": "", "author": "",
        "chapters": [{"num": n, "name": f"Chapter {n}"} for n in nums],
        "_base": base, "_slug": slug,
    }


def azora_images(session, base, slug, n):
    h = azora_page(session, f"{base}/series/{slug}/chapter-{n}")
    found = {}
    for u in re.findall(r'(https?://[^"\'\s<>]+?/page-\d+[^"\'\s<>]*?\.(?:jpe?g|png|webp))', h):
        found.setdefault(int(re.search(r"/page-(\d+)", u).group(1)), u)
    return [found[k] for k in sorted(found)]


def azora_download(session, url, chapters_sel, out_path):
    info = azora_info(session, url)
    nums = [c["num"] for c in info["chapters"]]
    todo = pick_range(chapters_sel, nums)
    total = len(todo)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, n in enumerate(todo, start=1):
            emit("PROGRESS", f"{i - 1} {total} Chapter {n}")
            for idx, img_url in enumerate(azora_images(session, info["_base"], info["_slug"], n), start=1):
                try:
                    r = session.get(img_url, timeout=40)
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                ext = img_url.split(".")[-1].split("?")[0]
                if len(ext) > 4 or not ext.isalnum():
                    ext = "jpg"
                zf.writestr(f"{n}/{idx:03d}.{ext}", r.content)
            emit("PROGRESS", f"{i} {total} Chapter {n}")


# ----------------------------------------------------------------- kolnovel
def kolnovel_get(session, url):
    for i in range(4):
        try:
            r = session.get(url, timeout=40)
            if r.status_code == 200:
                return r.text
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(f"فشل تحميل {url}")


def kolnovel_info(session, url):
    soup = BeautifulSoup(kolnovel_get(session, url), "html.parser")
    title_el = soup.select_one("h1")
    title = clean_filename(title_el.get_text(strip=True)) if title_el else "Novel"
    chapters = []
    for a in soup.select(".eplister li > a"):
        num_el = a.select_one(".epl-num")
        m = re.search(r"([\d.]+)", num_el.get_text() if num_el else "")
        if m:
            name_el = a.select_one(".epl-title")
            chapters.append({
                "num": m.group(1), "name": name_el.get_text(" ", strip=True) if name_el else m.group(1),
                "link": a["href"],
            })
    chapters.sort(key=lambda c: float(c["num"]))
    return {
        "title": title, "description": "", "cover_url": "", "genres": [], "status": "", "author": "",
        "chapters": [{"num": c["num"], "name": c["name"]} for c in chapters],
        "_raw_chapters": chapters,
    }


def kolnovel_chapter_text(session, url):
    h = kolnovel_get(session, url)
    hidden = set()
    for css in re.findall(r"<style[^>]*>(.*?)</style>", h, re.S):
        for sel, body in re.findall(r"([^{}]+)\{([^}]*)\}", css):
            if re.search(r"height\s*:\s*0|opacity\s*:\s*0|display\s*:\s*none|text-indent\s*:\s*-\d", body):
                hidden |= set(re.findall(r"\.([\w-]+)", sel))
    soup = BeautifulSoup(h, "html.parser")
    box = soup.select_one("#kol_content") or soup.select_one(".epcontent")
    if not box:
        return ""
    for t in box.select("script, style, ins, iframe, blockquote, .code-block, [id*=_ad]"):
        t.decompose()
    for t in box.find_all(class_=lambda c: c and any(x in hidden for x in (c if isinstance(c, list) else [c]))):
        t.decompose()
    for br in box.find_all("br"):
        br.replace_with("\n")
    lines = []
    for p in box.find_all("p"):
        for child in p.find_all("p"):
            child.extract()
        t = p.get_text().strip()
        if t:
            lines.append(t)
    if not lines:
        lines = [box.get_text("\n").strip()]
    return "\n\n".join(lines)


def kolnovel_download(session, url, chapters_sel, out_path):
    info = kolnovel_info(session, url)
    raw = info["_raw_chapters"]
    nums = [c["num"] for c in raw]
    todo_nums = pick_range(chapters_sel, nums)
    todo = [c for c in raw if c["num"] in todo_nums]
    total = len(todo)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, ch in enumerate(todo, start=1):
            emit("PROGRESS", f"{i - 1} {total} {ch['name']}")
            text = kolnovel_chapter_text(session, ch["link"])
            zf.writestr(f"{ch['num']}.txt", text)
            emit("PROGRESS", f"{i} {total} {ch['name']}")
            time.sleep(0.4)


# ---------------------------------------------------------------------- cli
SITES = {
    "mangalek": {"info": mangalek_info, "download": mangalek_download, "needs_cf": True},
    "azora": {"info": azora_info, "download": azora_download, "needs_cf": False},
    "kolnovel": {"info": kolnovel_info, "download": kolnovel_download, "needs_cf": False},
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["info", "download"])
    ap.add_argument("--site", required=True, choices=list(SITES.keys()))
    ap.add_argument("--url", required=True)
    ap.add_argument("--chapters", default="all")
    ap.add_argument("--out")
    ap.add_argument("--cf", default="")
    ap.add_argument("--ua", default="")
    ap.add_argument("--upload-url", default="", help="if set, POST the finished zip here instead of just leaving it on disk")
    ap.add_argument("--api-key", default="")
    ap.add_argument("--keep-zip", action="store_true", help="don't delete the local zip after a successful upload")
    args = ap.parse_args()

    site = SITES[args.site]
    session = make_session(args.ua)

    try:
        if args.command == "info":
            if site["needs_cf"]:
                data = site["info"](session, args.url, args.cf)
            else:
                data = site["info"](session, args.url)
            data.pop("_raw_chapters", None)
            data.pop("_base", None)
            data.pop("_slug", None)
            emit("INFO", data)
            return

        if not args.out:
            import tempfile
            fd, args.out = tempfile.mkstemp(suffix=".zip", prefix="despair-scrape-")
            import os as _os
            _os.close(fd)
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        if site["needs_cf"]:
            site["download"](session, args.url, args.chapters, args.out, args.cf)
        else:
            site["download"](session, args.url, args.chapters, args.out)

        if args.upload_url:
            emit("UPLOADING", "1")
            with open(args.out, "rb") as f:
                zip_bytes = f.read()
            r = plain_requests.post(
                args.upload_url,
                data=zip_bytes,
                headers={"X-Uploader-Key": args.api_key, "Content-Type": "application/zip"},
                timeout=600,
            )
            try:
                resp_json = r.json()
            except Exception:
                resp_json = {"ok": False, "error": f"HTTP {r.status_code}"}
            if not args.keep_zip:
                try:
                    Path(args.out).unlink()
                except Exception:
                    pass
            if r.status_code >= 200 and r.status_code < 300 and resp_json.get("ok") is not False:
                emit("UPLOADED", resp_json)
            else:
                emit("ERROR", resp_json.get("error") or f"HTTP {r.status_code}")
                sys.exit(1)
        else:
            emit("DONE", args.out)
    except Exception as e:
        emit("ERROR", str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
