#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SRT / ASS -> VTT converter for the KazumiWeb subtitle plugin.

Library subtitles (Kitsunekko, TVsubtitles, SubDL, Jimaku, OpenSubtitles)
arrive as .srt or .ass. The player only understands WebVTT, so every
subtitle the plugin serves is converted to VTT first, then cached.

Cleaning (keeps the spoken line, drops the noise):
  - HTML / ASS override tags: <i>, <b>, {\\...}, \\N -> space/newline
  - Japanese furigana: 炭治郎(たんじろう) -> 炭治郎
  - Leading speaker labels: (炭治郎) at the start of a cue -> removed
  - Lines that are only a [sound description] -> removed
  - Music-only cues (♪) are kept (they are real on-screen content).

The VTT NOTE header states the source and whether it is machine-made,
so the player toast and any human audit can tell at a glance.
"""
import re

# Kanji run followed by a hiragana reading in parentheses = furigana.
_FURIGANA = re.compile(r"([\u4e00-\u9fff\u3400-\u4dbf]+)\(([ぁ-ん]+)\)")
# A line that is only a parenthesised label, e.g. （炭治郎） or (Sokka)
_LABEL_LINE = re.compile(r"^[（\(][^）\)]{1,12}[）\)]\s*$")
# A line that is only a [sound description]
_SOUND_LINE = re.compile(r"^\[[^\]]{1,60}\]\s*$")
_TAG = re.compile(r"<[^>]+>|\{[^}]*\}|\\[a-zA-Z]+\d*")


def _srt_time_to_vtt(t):
    """00:00:06,340 -> 00:00:06.340 (also accepts a dot separator)."""
    return t.replace(",", ".")


def _parse_srt_time(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s.replace(",", "."))


def _clean_text(text, lang):
    out_lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = _TAG.sub("", line)
        line = line.replace("\\N", " ").replace("\\n", " ")
        if _SOUND_LINE.match(line):
            continue
        if _LABEL_LINE.match(line):
            continue
        # Furigana first: 炭治郎(たんじろう) -> 炭治郎, so a speaker label
        # that carries furigana, （炭治郎(たんじろう)）, collapses to
        # （炭治郎） and the label strip below removes it cleanly.
        if lang == "ja":
            line = _FURIGANA.sub(r"\1", line)
        # leading speaker label on the same line: （炭治郎）ハア -> ハア
        line = re.sub(r"^[（\(][^）\)]{1,12}[）\)]\s*", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            out_lines.append(line)
    return " ".join(out_lines)


def parse_srt(data, lang="ja"):
    """Return a list of (start_sec, end_sec, text)."""
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="replace")
    data = data.replace("\r\n", "\n").replace("\r", "\n")
    cues = []
    blocks = re.split(r"\n\s*\n", data.strip())
    for block in blocks:
        lines = [l for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        m = None
        for i, l in enumerate(lines):
            mm = re.match(
                r"(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})", l)
            if mm:
                m = (mm.group(1), mm.group(2), lines[i + 1:])
                break
        if not m:
            continue
        text = _clean_text("\n".join(m[2]), lang)
        if not text:
            continue
        start = _parse_srt_time(m[0])
        end = _parse_srt_time(m[1])
        if end <= start:
            continue
        cues.append((start, end, text))
    cues.sort(key=lambda c: c[0])
    return cues


def _parse_ass_time(t):
    """0:00:06.34 -> seconds (centiseconds)."""
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def parse_ass(data, lang="ja"):
    """Parse an .ass file's Dialogue events. Returns (start, end, text)."""
    if isinstance(data, bytes):
        data = data.decode("utf-8-sig", errors="replace")
    cues = []
    in_events = False
    fmt = None
    for raw in data.splitlines():
        line = raw.strip()
        if line.lower() == "[events]":
            in_events = True
            continue
        if line.startswith("[") and line.endswith("]"):
            if in_events and line.lower() != "[events]":
                in_events = False
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            fmt = [f.strip().lower() for f in line[len("format:"):].split(",")]
            continue
        if line.lower().startswith("dialogue:"):
            body = line[len("dialogue:"):]
            if fmt and "text" in fmt:
                parts = body.split(",", len(fmt) - 1)
                d = dict(zip(fmt, [p.strip() for p in parts]))
                try:
                    start = _parse_ass_time(d["start"])
                    end = _parse_ass_time(d["end"])
                except Exception:
                    continue
                text = _clean_text(d.get("text", "").replace("\\N", "\n"), lang)
                if text and end > start:
                    cues.append((start, end, text))
    cues.sort(key=lambda c: c[0])
    return cues


def parse_subtitle(data, filename, lang="ja"):
    """Dispatch on extension. Returns a cue list."""
    name = (filename or "").lower()
    if name.endswith(".ass") or name.endswith(".ssa"):
        return parse_ass(data, lang)
    return parse_srt(data, lang)


def _fmt_vtt_ts(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d.%03d" % (h, m, s, ms)


def cues_to_vtt(cues, source_label, machine=False, lang="ja"):
    """Build a WebVTT document. The NOTE header states the source.

    source_label examples: "Kitsunekko（人工字幕）",
    "TVsubtitles（人工字幕）", "Groq Whisper（机器生成）".
    """
    kind = "机器生成，仅供参考" if machine else "人工字幕"
    lines = ["WEBVTT", "", "NOTE", "%s（%s）" % (source_label, kind), ""]
    for start, end, text in cues:
        # A very long line is split for the overlay (the player shows one
        # line per cue; keep it readable on a phone).
        lines.append("%s --> %s" % (_fmt_vtt_ts(start), _fmt_vtt_ts(end)))
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def convert(data, filename, lang, source_label, machine=False):
    """Full pipeline: bytes + filename -> VTT text. Raises ValueError if
    no usable cues were found."""
    cues = parse_subtitle(data, filename, lang)
    if not cues:
        raise ValueError("no cues parsed from %s" % filename)
    return cues_to_vtt(cues, source_label, machine=machine, lang=lang), len(cues)
