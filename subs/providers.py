#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Library subtitle providers for the KazumiWeb subtitle plugin.

Each provider is a function:
    find(...) -> (content_bytes, filename, source_label) | None
`content_bytes` is the raw .srt/.ass file; the caller converts it to VTT.

Keyless providers (work with no API key):
  - kitsunekko: Japanese anime subtitles, via the Ajatt-Tools mirror on
    GitHub (raw.githubusercontent.com). No key, CORS-friendly, fast.
    The mirror's directory name is the romaji title, so the caller must
    supply the romaji dir name (aliases.json) or a Bangumi name that
    already matches it.
  - tvsubtitles: English (and other) TV subtitles, via tvsubtitles.net.
    No key, no account. The download page builds its zip URL in JS;
    this provider reconstructs it the same way.

Keyed providers (env var present -> enabled, absent -> skipped):
  - jimaku: Jimaku.cc API (JIMAKU_API_KEY). Searches by the Japanese
    title, so it covers kanji-titled anime that Kitsunekko cannot match.
  - opensubtitles: OpenSubtitles API (OPENSUBTITLES_API_KEY).
    Covers movies and Western TV.

All network calls have short timeouts and never raise: a provider that
fails returns None and the caller moves on to the next provider.
"""
import io
import json
import os
import re
import time
import urllib.parse
import urllib.request
import zipfile

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
TIMEOUT = 20


def _get(url, headers=None, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers=headers or UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _get_json(url, headers=None, timeout=TIMEOUT):
    return json.loads(_get(url, headers, timeout).decode("utf-8", "replace"))


def _norm(s):
    """Normalise a title for matching: lowercase, drop punctuation and
    spaces, drop a leading 'the '."""
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", s)
    if s.startswith("the"):
        s = s[3:]
    return s


def _ep_patterns(season, ep):
    """Filename fragments that identify S<ss>E<ee> (and the common
    fallbacks: E<ee>, 1x<ee>, ' - <ee> ')."""
    s, e = int(season), int(ep)
    return [
        "s%02de%02d" % (s, e),
        "s%de%02d" % (s, e),
        "e%02d" % e,
        "%dx%02d" % (s, e),
        " - %02d " % e,
        " - %d " % e,
    ]


# ---------------------------------------------------------------- kitsunekko
_KITSU_API = "https://api.github.com/repos/Ajatt-Tools/kitsunekko-mirror/contents/"
_KITSU_RAW = "https://raw.githubusercontent.com/Ajatt-Tools/kitsunekko-mirror/main/"
_kitsu_dir_cache = {}  # dir name -> (timestamp, [file names])


def _kitsu_list_dir(dirname):
    now = time.time()
    hit = _kitsu_dir_cache.get(dirname)
    if hit and now - hit[0] < 3600:
        return hit[1]
    url = _KITSU_API + "subtitles/anime_tv/" + urllib.parse.quote(dirname)
    try:
        items = _get_json(url)
    except Exception:
        return None
    if not isinstance(items, list):
        return None
    names = [it.get("name", "") for it in items if it.get("type") == "file"]
    _kitsu_dir_cache[dirname] = (now, names)
    return names


def kitsunekko(dirname, season, ep, lang="ja"):
    """Find a subtitle file in the Kitsunekko mirror for one episode.

    dirname: the mirror directory name (romaji title), e.g.
    "Kimetsu no Yaiba". Returns (bytes, filename, "Kitsunekko") or None.
    """
    if not dirname:
        return None
    try:
        names = _kitsu_list_dir(dirname)
    except Exception:
        return None
    if not names:
        return None
    pats = _ep_patterns(season, ep)
    cands = []
    for name in names:
        low = name.lower()
        if ("." + lang + ".") not in low and not low.endswith("." + lang + ".srt") \
                and not low.endswith("." + lang + ".ass"):
            continue
        if not (low.endswith(".srt") or low.endswith(".ass")):
            continue
        if any(p in low.replace(" ", "").replace("_", "") or p in low for p in pats):
            cands.append(name)
    if not cands:
        return None
    # Prefer a plain / retimed release over a fansub-group release.
    def _rank(n):
        low = n.lower()
        score = 0
        if "retime" in low:
            score += 2
        if low.startswith("["):
            score -= 1
        return -score
    cands.sort(key=_rank)
    fname = cands[0]
    url = _KITSU_RAW + "subtitles/anime_tv/" + urllib.parse.quote(dirname) + "/" + urllib.parse.quote(fname)
    try:
        data = _get(url, timeout=30)
    except Exception:
        return None
    if len(data) < 200:
        return None
    return data, fname, "Kitsunekko"


# --------------------------------------------------------------- tvsubtitles
_TVSUB_BASE = "https://www.tvsubtitles.net/"
_tvsub_list_cache = {"ts": 0, "shows": []}  # (tvshow_id, title, seasons)


def _tvsub_show_list():
    now = time.time()
    if _tvsub_list_cache["shows"] and now - _tvsub_list_cache["ts"] < 86400:
        return _tvsub_list_cache["shows"]
    try:
        html = _get(_TVSUB_BASE + "tvshows.html", timeout=30).decode("utf-8", "replace")
    except Exception:
        return _tvsub_list_cache["shows"]
    shows = []
    for m in re.finditer(r'href="tvshow-(\d+)-\d+\.html"><b>([^<]+)</b></a>', html):
        shows.append((int(m.group(1)), m.group(2).strip()))
    if shows:
        _tvsub_list_cache.update({"ts": now, "shows": shows})
    return shows


def _tvsub_find_show(title, title_cn=None):
    """Match a show title to a tvsubtitles tvshow id. Returns id or None."""
    shows = _tvsub_show_list()
    if not shows:
        return None
    for cand in (title, title_cn):
        if not cand:
            continue
        n = _norm(cand)
        if not n:
            continue
        for sid, t in shows:
            if _norm(t) == n:
                return sid
        for sid, t in shows:
            if n and n in _norm(t):
                return sid
    return None


def _tvsub_episode_sub_id(show_id, season, ep, lang="en"):
    """Fetch the season page, find the episode row, return the subtitle id
    for the requested language flag (en / zh / ...).

    Two layouts exist on the season page:
      a) a direct subtitle link with the language flag, e.g.
         subtitle-24183.html + <img alt="en">  (Avatar 1x01)
      b) only an episode-language link, e.g. episode-48088-en.html,
         which lists that language's subtitle files for the episode
         (Rick and Morty 1x01). In that case the episode page is fetched
         and the most-downloaded subtitle wins.
    """
    url = "%stvshow-%d-%d.html" % (_TVSUB_BASE, show_id, int(season))
    try:
        html = _get(url, timeout=30).decode("utf-8", "replace")
    except Exception:
        return None
    code = "%dx%02d" % (int(season), int(ep))
    rows = re.findall(
        r'<td>%s</td>\s*<td[^>]*><a href="episode-\d+\.html"><b>([^<]*)</b></a></td>\s*<td>\d+</td>\s*<td>(.*?)</td>'
        % re.escape(code), html, re.S)
    if not rows:
        return None
    subs_html = rows[0][1]
    m = re.search(r'subtitle-(\d+)\.html"><img[^>]*alt="%s"' % re.escape(lang), subs_html)
    if m:
        return int(m.group(1))
    # Layout (b): follow the episode-<lang> link.
    m = re.search(r'href="(episode-\d+-%s\.html)"' % re.escape(lang), subs_html)
    if not m:
        m = re.search(r'subtitle-(\d+)\.html', subs_html)
        return int(m.group(1)) if m else None
    try:
        ep_html = _get(_TVSUB_BASE + m.group(1), timeout=30).decode("utf-8", "replace")
    except Exception:
        return None
    best_id, best_dl = None, -1
    # Split on subtitle links; each block carries its own download count.
    parts = re.split(r'<a href="/subtitle-(\d+)\.html">', ep_html)
    for i in range(1, len(parts) - 1, 2):
        sid = int(parts[i])
        block = parts[i + 1]
        dm = re.search(r'title="downloaded">(?:<[^>]+>|\s)*([0-9][0-9,]*)', block)
        dl = int(dm.group(1).replace(",", "")) if dm else 0
        if dl > best_dl:
            best_id, best_dl = sid, dl
    return best_id


def _tvsub_download(sub_id):
    """Download a subtitle zip the way the site's own JS does:
    GET /download-<id>.html, read var s1..s4, GET files/<joined> (a zip),
    extract the first .srt/.ass."""
    page_url = "%sdownload-%d.html" % (_TVSUB_BASE, sub_id)
    try:
        html = _get(page_url, headers={**UA, "Referer": "%ssubtitle-%d.html" % (_TVSUB_BASE, sub_id)},
                    timeout=30).decode("utf-8", "replace")
    except Exception:
        return None
    parts = re.findall(r"var s\d+\s*=\s*'([^']*)'", html)
    if not parts:
        return None
    # The filename contains spaces (e.g. "Rick and Morty_1x01_....zip");
    # quote the path or the request fails.
    zip_url = _TVSUB_BASE + urllib.parse.quote("".join(parts), safe="/:")
    try:
        data = _get(zip_url, headers={**UA, "Referer": page_url}, timeout=60)
    except Exception:
        return None
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except Exception:
        return None
    for name in z.namelist():
        if name.lower().endswith((".srt", ".ass")):
            return z.read(name), name, "TVsubtitles"
    return None


def tvsubtitles(title, season, ep, lang="en", title_cn=None, show_id=None):
    """Find an episode subtitle on tvsubtitles.net."""
    try:
        sid = show_id or _tvsub_find_show(title, title_cn)
        if not sid:
            return None
        sub_id = _tvsub_episode_sub_id(sid, season, ep, lang)
        if not sub_id:
            return None
        return _tvsub_download(sub_id)
    except Exception:
        return None


# -------------------------------------------------------------------- jimaku
def jimaku(query, season, ep, lang="ja", api_key=None):
    """Jimaku.cc API. Searches entries by title, then lists the files and
    picks the one for the requested season/episode/language."""
    key = api_key or os.environ.get("JIMAKU_API_KEY", "")
    if not key or not query:
        return None
    headers = {**UA, "Authorization": key}
    try:
        res = _get_json(
            "https://jimaku.cc/api/entries/search?query=" + urllib.parse.quote(query),
            headers=headers)
        entries = res if isinstance(res, list) else res.get("entries", [])
        if not entries:
            return None
        entry = entries[0]
        eid = entry.get("id")
        files = _get_json("https://jimaku.cc/api/entries/%s/files" % eid, headers=headers)
        files = files if isinstance(files, list) else files.get("files", [])
    except Exception:
        return None
    pats = _ep_patterns(season, ep)
    best = None
    for f in files:
        name = (f.get("name") or "").lower()
        if not name.endswith((".srt", ".ass")):
            continue
        if lang == "ja" and ".ja." not in name and "jpn" not in name and "ja" not in name:
            continue
        if lang == "en" and ".en." not in name and "eng" not in name:
            continue
        if any(p in name.replace(" ", "").replace("_", "") or p in name for p in pats):
            best = f
            break
    if not best:
        return None
    url = best.get("url") or best.get("download_url")
    if not url:
        return None
    try:
        data = _get(url, headers=headers, timeout=60)
    except Exception:
        return None
    return data, best.get("name", "subtitle.srt"), "Jimaku"


# ------------------------------------------------------------- opensubtitles
def opensubtitles(title, season, ep, lang="en", api_key=None):
    """OpenSubtitles API v1. Needs an API key (OPENSUBTITLES_API_KEY)."""
    key = api_key or os.environ.get("OPENSUBTITLES_API_KEY", "")
    if not key or not title:
        return None
    headers = {**UA, "Api-Key": key, "Content-Type": "application/json"}
    import urllib.request as _u
    body = json.dumps({
        "query": title,
        "season_number": int(season),
        "episode_number": int(ep),
        "languages": lang,
    }).encode("utf-8")
    try:
        req = _u.Request("https://api.opensubtitles.com/api/v1/subtitles",
                         data=body, headers=headers, method="POST")
        with _u.urlopen(req, timeout=30) as r:
            res = json.loads(r.read().decode("utf-8", "replace"))
        items = res.get("data", [])
        if not items:
            return None
        f = items[0].get("attributes", {}).get("files", [{}])[0]
        fid = f.get("file_id")
        if not fid:
            return None
        body2 = json.dumps({"file_id": fid}).encode("utf-8")
        req2 = _u.Request("https://api.opensubtitles.com/api/v1/download",
                          data=body2, headers=headers, method="POST")
        with _u.urlopen(req2, timeout=30) as r:
            dl = json.loads(r.read().decode("utf-8", "replace"))
        url = dl.get("link")
        if not url:
            return None
        data = _get(url, timeout=60)
        return data, "subtitle.srt", "OpenSubtitles"
    except Exception:
        return None
