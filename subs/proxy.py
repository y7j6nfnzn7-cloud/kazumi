#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""KazumiWeb subtitle plugin: reverse proxy + subtitle service (sidecar).

This process is the container's public front door (it listens on $PORT).
It does two things:

1. Subtitle endpoints (handled locally, never proxied):
     GET  /api/subs/<bid>/ep<NN>?lang=<lang>
          Cache-only read. Returns the cached VTT (200) or 404 JSON.
          It NEVER generates, NEVER waits, NEVER shows a "generating"
          state. Playback reads only from cache.
     POST /api/subs/prepare   {bid, ep, lang?, title?, titleCn?,
                               episodeUrl?, season?}
          Fire-and-forget warm-up. Returns 202 immediately. A background
          worker fetches the subtitle from a library, converts it to VTT
          and caches it; only if no library has it does it fall back to
          Groq Whisper generation. Called when a show's detail page (or
          episode list) opens, so the subtitle is ready BEFORE play.
          Also warms the next episode (ep+1) so the cache stays ahead.
     GET  /api/subs/status/<bid>/ep<NN>   -> {status, source, ...}
     GET  /api/subs/health                -> {ok, cache, groq, jimaku, ...}
3. Skip-point reports (handled locally, never proxied):
     POST /api/skip-points/report   {key, bid, plugin, introEnd, samples,
                                     source, count}
          Append-only. Stores the report in subs/skip-reports.json for
          Mika to review before writing the official web/skip-points.json.
          It NEVER writes the official table, NEVER installs/deletes a
          rule, NEVER changes playback. Invalid bodies get 400.
     GET  /api/skip-points/reports  -> {count, reports:[...]}
          Read-only list for Mika's review (container-local file; pull
          it before redeploy, the container filesystem does not survive).
     GET  /api/skip-points/learned  -> {points: {key: {introEnd, source, count}}}
          Read-only aggregate of reported points with count>=3 (latest
          report wins per key). The player fetches this at startup as a
          third introEnd source (after local skipPromoted + static
          skip-points.json) so a point learned on one device works on
          another without waiting for Mika to write the official table.
2. Everything else is reverse-proxied to the KazumiWeb binary on
   127.0.0.1:10001 (SUBS_UPSTREAM), streaming, with Range support,
   so video playback is unaffected.

Fallback generation (Groq Whisper, free tier) — only for shows no
library has, and only the ORIGINAL-language track (the Chinese is the
video's own burned-in hardsub; the player never displays a zh VTT,
so no OCR is ever run). A 12-minute episode takes ~1-3 minutes
(download + Groq), not the 30-60 minutes local faster-whisper took.
Needs GROQ_API_KEY; without it the episode stays "miss" (queued for
a human/VM-side generation) and the player just plays without an
overlay — honestly, with no loading spinner.

Environment:
  PORT / SUBS_PUBLIC_PORT : public port (default 10000)
  SUBS_UPSTREAM           : kazumi_web origin (default http://127.0.0.1:10001)
  SUBS_CACHE_DIR          : VTT cache (default <this dir>/cache)
  GROQ_API_KEY            : Groq free Whisper key (optional)
  JIMAKU_API_KEY          : Jimaku key (optional)
  OPENSUBTITLES_API_KEY   : OpenSubtitles key (optional)

Standard library only. No pip packages.
"""
import concurrent.futures
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import convert as _convert          # noqa: E402
import providers as _providers     # noqa: E402

PUBLIC_PORT = int(os.environ.get("SUBS_PUBLIC_PORT") or os.environ.get("PORT") or 10000)
UPSTREAM = os.environ.get("SUBS_UPSTREAM", "http://127.0.0.1:10001").rstrip("/")
CACHE_DIR = os.environ.get("SUBS_CACHE_DIR", os.path.join(HERE, "cache"))
GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "whisper-large-v3-turbo")
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
HOP_BY_HOP = {"connection", "keep-alive", "proxy-connection", "te", "trailer",
              "proxy-authorization", "proxy-authenticate", "upgrade",
              "transfer-encoding"}

os.makedirs(CACHE_DIR, exist_ok=True)

# Skip-point reports: append-only review queue (see module docstring).
# Container-local; Mika pulls it via GET /api/skip-points/reports.
SKIP_REPORTS_FILE = os.path.join(HERE, "skip-reports.json")
SKIP_REPORTS_MAX = 200
_skip_lock = threading.Lock()


def _load_skip_reports():
    try:
        with open(SKIP_REPORTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _append_skip_report(entry):
    with _skip_lock:
        reports = _load_skip_reports()
        reports.append(entry)
        reports = reports[-SKIP_REPORTS_MAX:]
        tmp = SKIP_REPORTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(reports, f, ensure_ascii=False, indent=1)
        os.replace(tmp, SKIP_REPORTS_FILE)
        return len(reports)


def _learned_skip_points():
    # 聚合已上报且 count>=3 的 learned 点：同一 key 以最新上报为准；
    # 只读，不写正式表。播放页当第三来源读回，跨设备共享。
    points = {}
    for r in _load_skip_reports():
        try:
            if int(r.get("count") or 0) < 3:
                continue
            key = str(r.get("key") or "")
            intro = int(r.get("introEnd"))
            if not key or not 10 <= intro <= 180:
                continue
            points[key] = {"introEnd": intro, "source": "learned",
                           "count": int(r.get("count") or 0)}
        except (TypeError, ValueError):
            continue
    return points

# ------------------------------------------------------------------ state
_status = {}            # (bid, ep, lang) -> dict(status, source, updated)
_status_lock = threading.Lock()
_aliases = {}
try:
    with open(os.path.join(HERE, "aliases.json"), encoding="utf-8") as f:
        _aliases = json.load(f)
except Exception:
    _aliases = {}
_preparing = set()
_preparing_lock = threading.Lock()
_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)


def _cache_name(bid, ep, lang):
    return "%s-ep%02d.%s.vtt" % (str(bid), int(ep), lang)


def _cache_path(bid, ep, lang):
    return os.path.join(CACHE_DIR, _cache_name(bid, ep, lang))


def _set_status(bid, ep, lang, status, source="", detail=""):
    with _status_lock:
        _status[(str(bid), int(ep), lang)] = {
            "status": status, "source": source, "detail": detail,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }


def _get_status(bid, ep, lang):
    with _status_lock:
        return dict(_status.get((str(bid), int(ep), lang), {}))


# ------------------------------------------------------------- bangumi info
def _bangumi_info(bid):
    """Fetch the show's name/tags from the upstream KazumiWeb binary."""
    try:
        req = urllib.request.Request(
            UPSTREAM + "/api/bangumi/" + urllib.parse.quote(str(bid)), headers=UA)
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception:
        return {}


def _overlay_lang(info):
    """Decide the overlay language from Bangumi tags (same rule as the
    player): Japanese -> ja; US/Europe/UK/FR/CA/AU/DE -> en; China -> en
    (Chinese shows get an English overlay, machine-translated later);
    unknown -> ja."""
    tags = []
    for t in (info or {}).get("tags", []) or []:
        if isinstance(t, dict):
            tags.append(t.get("name", ""))
        else:
            tags.append(str(t))
    joined = " ".join(tags)
    if any(k in joined for k in ("日本",)):
        return "ja"
    if any(k in joined for k in ("美国", "欧美", "英国", "法国", "加拿大", "澳大利亚", "德国")):
        return "en"
    if any(k in joined for k in ("中国", "国产", "大陆", "香港", "台湾")):
        return "en"
    return "ja"


# ------------------------------------------------------------ library lookup
def _library_lookup(bid, ep, lang, info, season=1):
    """Try the subtitle libraries, in order. Returns
    (vtt_text, source_label) or None."""
    name = (info or {}).get("name") or ""
    name_cn = (info or {}).get("nameCn") or ""
    alias = _aliases.get(str(bid), {}) if isinstance(_aliases.get(str(bid)), dict) else {}
    title = alias.get("title") or name
    if lang == "ja":
        # 1) Kitsunekko mirror (keyless). Needs the romaji dir name.
        for dirname in (alias.get("kitsunekko_dir"), name, name_cn):
            if not dirname:
                continue
            try:
                hit = _providers.kitsunekko(dirname, season, ep, "ja")
            except Exception:
                hit = None
            if hit:
                data, fname, src = hit
                try:
                    vtt, _n = _convert.convert(data, fname, "ja", src, machine=False)
                    return vtt, src
                except Exception:
                    continue
        # 2) Jimaku (keyed) — searches by the Japanese title.
        try:
            hit = _providers.jimaku(name or name_cn, season, ep, "ja")
        except Exception:
            hit = None
        if hit:
            data, fname, src = hit
            try:
                vtt, _n = _convert.convert(data, fname, "ja", src, machine=False)
                return vtt, src
            except Exception:
                pass
    else:  # en
        # 1) TVsubtitles (keyless).
        try:
            hit = _providers.tvsubtitles(title, season, ep, "en",
                                         title_cn=name_cn,
                                         show_id=alias.get("tvsubtitles_id"))
        except Exception:
            hit = None
        if hit:
            data, fname, src = hit
            try:
                vtt, _n = _convert.convert(data, fname, "en", src, machine=False)
                return vtt, src
            except Exception:
                pass
        # 2) OpenSubtitles (keyed), 3) Jimaku (keyed).
        for fn in (_providers.opensubtitles, _providers.jimaku):
            try:
                hit = fn(title or name, season, ep, "en")
            except Exception:
                hit = None
            if hit:
                data, fname, src = hit
                try:
                    vtt, _n = _convert.convert(data, fname, "en", src, machine=False)
                    return vtt, src
                except Exception:
                    continue
    return None


# -------------------------------------------------------------- groq fallback
def _resolve_video(episode_url):
    """Ask the upstream binary to resolve an AGE play URL to a video URL."""
    if not episode_url:
        return None
    try:
        q = urllib.parse.urlencode({"plugin": "AGE", "episodeUrl": episode_url})
        req = urllib.request.Request(UPSTREAM + "/api/resolve?" + q, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
        return d.get("originalUrl") or d.get("url")
    except Exception:
        return None


def _groq_transcribe(audio_path, lang):
    """Send one audio file to Groq Whisper. Returns a list of segments
    [{start, end, text}] (verbose_json)."""
    boundary = "----muse-groq-%d" % int(time.time() * 1000)
    parts = []
    fields = {
        "model": GROQ_MODEL,
        "language": lang,
        "response_format": "verbose_json",
        "timestamp_granularities[]": "segment",
    }
    for k, v in fields.items():
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                      % (boundary, k, v)).encode("utf-8"))
    with open(audio_path, "rb") as f:
        audio = f.read()
    fname = os.path.basename(audio_path)
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                  "Content-Type: audio/mpeg\r\n\r\n" % (boundary, fname)).encode("utf-8"))
    parts.append(audio)
    parts.append(("\r\n--%s--\r\n" % boundary).encode("utf-8"))
    body = b"".join(parts)
    req = urllib.request.Request(GROQ_URL, data=body, headers={
        **UA,
        "Authorization": "Bearer " + GROQ_KEY,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
    }, method="POST")
    with urllib.request.urlopen(req, timeout=300) as r:
        res = json.loads(r.read().decode("utf-8", "replace"))
    segs = []
    for s in res.get("segments", []) or []:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        segs.append({"start": float(s.get("start", 0)),
                     "end": float(s.get("end", 0)), "text": text})
    return segs


def _groq_generate(bid, ep, lang, episode_url, info):
    """Download the episode video, extract audio, transcribe with Groq,
    cache the VTT. Returns (vtt_text, source_label) or None.
    Only the original-language track is generated (the Chinese is the
    video's own hardsub; no OCR is run)."""
    if not GROQ_KEY:
        return None
    video_url = _resolve_video(episode_url)
    if not video_url:
        return None
    tmp = tempfile.mkdtemp(prefix="subs-gen-")
    try:
        video_path = os.path.join(tmp, "video.mp4")
        # Download with a size cap (800 MB) — the CDN is fast.
        req = urllib.request.Request(video_url, headers=UA)
        size = 0
        with urllib.request.urlopen(req, timeout=30) as r, open(video_path, "wb") as f:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > 800 * 1024 * 1024:
                    return None
                f.write(chunk)
        # Probe duration (ffprobe) to decide whether to split.
        dur = 0.0
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", video_path],
                capture_output=True, text=True, timeout=30).stdout.strip()
            dur = float(out)
        except Exception:
            dur = 0.0
        # Extract audio as 64 kbps mono mp3 (small, fast to upload).
        # Split into ~10-minute chunks if the audio would exceed Groq's
        # 25 MB file limit; transcribe chunks in parallel.
        chunks = []
        if dur > 900:
            n = int(dur // 600) + 1
            step = dur / n
            for i in range(n):
                ap = os.path.join(tmp, "audio%d.mp3" % i)
                subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-ss", str(i * step),
                     "-t", str(step), "-i", video_path, "-vn", "-ac", "1",
                     "-ar", "16000", "-b:a", "64k", ap],
                    timeout=180, check=False)
                if os.path.exists(ap) and os.path.getsize(ap) > 0:
                    chunks.append((i * step, ap))
        else:
            ap = os.path.join(tmp, "audio.mp3")
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", video_path, "-vn",
                 "-ac", "1", "-ar", "16000", "-b:a", "64k", ap],
                timeout=180, check=False)
            if os.path.exists(ap) and os.path.getsize(ap) > 0:
                chunks.append((0.0, ap))
        if not chunks:
            return None
        all_segs = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(_groq_transcribe, ap, lang): off for off, ap in chunks}
            for fut in concurrent.futures.as_completed(futs):
                off = futs[fut]
                try:
                    for s in fut.result():
                        all_segs.append({"start": s["start"] + off,
                                         "end": s["end"] + off, "text": s["text"]})
                except Exception:
                    continue
        if not all_segs:
            return None
        all_segs.sort(key=lambda s: s["start"])
        cues = [(s["start"], s["end"], s["text"]) for s in all_segs]
        vtt = _convert.cues_to_vtt(cues, "Groq Whisper", machine=True, lang=lang)
        return vtt, "Groq Whisper"
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ prepare
def _prepare(bid, ep, lang, info, episode_url, season=1):
    """Background warm-up for one episode. Cache -> library -> Groq.
    Never raises."""
    key = (str(bid), int(ep), lang)
    with _preparing_lock:
        if key in _preparing:
            return
        _preparing.add(key)
    try:
        path = _cache_path(bid, ep, lang)
        if os.path.exists(path) and os.path.getsize(path) > 100:
            _set_status(bid, ep, lang, "cached", "cache")
            return
        _set_status(bid, ep, lang, "preparing", "", "library")
        hit = _library_lookup(bid, ep, lang, info, season)
        if hit:
            vtt, src = hit
            with open(path, "w", encoding="utf-8") as f:
                f.write(vtt)
            _set_status(bid, ep, lang, "cached", src)
            return
        _set_status(bid, ep, lang, "preparing", "", "groq")
        hit = _groq_generate(bid, ep, lang, episode_url, info)
        if hit:
            vtt, src = hit
            with open(path, "w", encoding="utf-8") as f:
                f.write(vtt)
            _set_status(bid, ep, lang, "cached", src)
            return
        _set_status(bid, ep, lang, "miss", "",
                    "no library subtitle; groq unavailable" if not GROQ_KEY
                    else "no library subtitle; groq failed")
    finally:
        with _preparing_lock:
            _preparing.discard(key)


def _warm(bid, ep, lang, info, episode_url, season=1):
    _pool.submit(_prepare, bid, ep, lang, info, episode_url, season)


# ------------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KazumiSubs/1.0"

    def log_message(self, fmt, *args):  # keep the log quiet
        sys.stderr.write("[subs] %s - %s\n" % (self.address_string(), fmt % args))

    # -- helpers ------------------------------------------------------
    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 65536:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8", "replace"))
        except Exception:
            return {}

    # -- subtitle endpoints -------------------------------------------
    def _handle_subs(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        m = re.match(r"^/api/subs/(\d+)/ep(\d+)$", path)
        if m and self.command == "GET":
            bid, ep = m.group(1), int(m.group(2))
            lang = (qs.get("lang") or [""])[0] or None
            if not lang:
                info = _bangumi_info(bid)
                lang = _overlay_lang(info)
            fpath = _cache_path(bid, ep, lang)
            if os.path.exists(fpath) and os.path.getsize(fpath) > 100:
                with open(fpath, "rb") as f:
                    data = f.read()
                st = _get_status(bid, ep, lang)
                self.send_response(200)
                self.send_header("Content-Type", "text/vtt; charset=utf-8")
                self.send_header("X-Sub-Source", st.get("source", "cache"))
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return True
            st = _get_status(bid, ep, lang)
            self._send_json(404, {"error": "not_cached",
                                  "status": st.get("status", "unknown"),
                                  "detail": st.get("detail", "")})
            return True
        if path == "/api/subs/prepare" and self.command == "POST":
            body = self._read_json_body()
            try:
                bid = str(body.get("bid", ""))
                ep = int(body.get("ep", 1))
            except (TypeError, ValueError):
                self._send_json(400, {"error": "bad bid/ep"})
                return True
            if not bid:
                self._send_json(400, {"error": "bad bid/ep"})
                return True
            lang = body.get("lang")
            season = int(body.get("season") or 1)
            episode_url = body.get("episodeUrl") or ""
            info = _bangumi_info(bid)
            if not lang:
                lang = _overlay_lang(info)
            fpath = _cache_path(bid, ep, lang)
            if os.path.exists(fpath) and os.path.getsize(fpath) > 100:
                self._send_json(200, {"status": "cached"})
                return True
            _warm(bid, ep, lang, info, episode_url, season)
            self._send_json(202, {"status": "started"})
            return True
        m = re.match(r"^/api/subs/status/(\d+)/ep(\d+)$", path)
        if m and self.command == "GET":
            bid, ep = m.group(1), int(m.group(2))
            lang = (qs.get("lang") or [""])[0] or None
            if not lang:
                lang = _overlay_lang(_bangumi_info(bid))
            st = _get_status(bid, ep, lang)
            cached = os.path.exists(_cache_path(bid, ep, lang))
            self._send_json(200, {"bid": bid, "episode": ep, "lang": lang,
                                  "cached": cached, **st})
            return True
        if path == "/api/subs/health" and self.command == "GET":
            try:
                cached = [f for f in os.listdir(CACHE_DIR) if f.endswith(".vtt")]
            except Exception:
                cached = []
            self._send_json(200, {
                "ok": True,
                "cached_vtt": len(cached),
                "groq": bool(GROQ_KEY),
                "jimaku": bool(os.environ.get("JIMAKU_API_KEY", "")),
                "opensubtitles": bool(os.environ.get("OPENSUBTITLES_API_KEY", "")),
                "upstream": UPSTREAM,
            })
            return True
        return False

    # -- skip-point reports (review queue only) ----------------------
    def _handle_skip_points(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path == "/api/skip-points/report" and self.command == "POST":
            body = self._read_json_body()
            try:
                bid = str(body.get("bid", ""))
                plugin = str(body.get("plugin", ""))
                intro_end = int(body.get("introEnd"))
                samples = body.get("samples") or []
                count = int(body.get("count") or 0)
            except (TypeError, ValueError):
                self._send_json(400, {"error": "bad report body"})
                return True
            # introEnd 只在片头时段内才合理；samples 必须是秒数列表
            if (not bid or not bid.isdigit() or not plugin or len(plugin) > 64
                    or not 10 <= intro_end <= 180
                    or not isinstance(samples, list)
                    or not all(isinstance(s, (int, float)) and 10 <= s <= 180 for s in samples)):
                self._send_json(400, {"error": "bad report body"})
                return True
            entry = {
                "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "key": str(body.get("key") or (bid + "|" + plugin)),
                "bid": bid,
                "plugin": plugin,
                "introEnd": intro_end,
                "samples": [int(s) for s in samples][-20:],
                "source": str(body.get("source") or "learned"),
                "count": count,
            }
            n = _append_skip_report(entry)
            self._send_json(200, {"status": "received", "stored": n})
            return True
        if path == "/api/skip-points/reports" and self.command == "GET":
            reports = _load_skip_reports()
            self._send_json(200, {"count": len(reports), "reports": reports})
            return True
        if path == "/api/skip-points/learned" and self.command == "GET":
            self._send_json(200, {"points": _learned_skip_points()})
            return True
        return False

    # -- reverse proxy -------------------------------------------------
    def _handle_proxy(self):
        url = UPSTREAM + self.path
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in HOP_BY_HOP}
        headers["Host"] = urllib.parse.urlparse(UPSTREAM).netloc
        body = None
        if self.command in ("POST", "PUT", "PATCH", "DELETE"):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n > 0:
                body = self.rfile.read(n)
        req = urllib.request.Request(url, data=body, headers=headers,
                                     method=self.command)
        try:
            resp = urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as e:
            # Pass the upstream error status/body through.
            data = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() not in HOP_BY_HOP:
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        except Exception as e:
            self._send_json(502, {"error": "upstream_unavailable",
                                  "detail": str(e)[:200]})
            return
        self.send_response(resp.status)
        length = resp.headers.get("Content-Length")
        for k, v in resp.headers.items():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        if length is None:
            # Chunked output: the upstream did not give a length.
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            if length is not None:
                shutil.copyfileobj(resp, self.wfile, length=65536)
            else:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n" % len(chunk))
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            resp.close()

    # -- dispatch ------------------------------------------------------
    def do_GET(self):
        if self.path.startswith("/api/subs/"):
            if self._handle_subs():
                return
        if self.path.startswith("/api/skip-points/"):
            if self._handle_skip_points():
                return
        self._handle_proxy()

    def do_POST(self):
        if self.path.startswith("/api/subs/"):
            if self._handle_subs():
                return
        if self.path.startswith("/api/skip-points/"):
            if self._handle_skip_points():
                return
        self._handle_proxy()

    def do_HEAD(self):
        if self.path.startswith("/api/subs/"):
            if self._handle_subs():
                return
        self._handle_proxy()

    def do_PUT(self):
        self._handle_proxy()

    def do_DELETE(self):
        self._handle_proxy()

    def do_PATCH(self):
        self._handle_proxy()


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PUBLIC_PORT), Handler)
    sys.stderr.write("[subs] listening on %d, upstream %s, cache %s\n"
                     % (PUBLIC_PORT, UPSTREAM, CACHE_DIR))
    sys.stderr.write("[subs] groq=%s jimaku=%s opensubtitles=%s\n"
                     % (bool(GROQ_KEY), bool(os.environ.get("JIMAKU_API_KEY", "")),
                        bool(os.environ.get("OPENSUBTITLES_API_KEY", ""))))
    srv.serve_forever()


if __name__ == "__main__":
    main()
