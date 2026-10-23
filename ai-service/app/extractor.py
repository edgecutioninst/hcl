"""Deterministic document classifier + field extractor for OCR text.

classify() and extract() are pure functions of the text (plus reference lexicons). Every field carries a
confidence in [0,1] and a source_span (char offsets into the ORIGINAL text) so the officer UI can highlight it.
Document text is data: nothing in it is ever executed or followed.
"""
from __future__ import annotations

import csv
import os
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from rapidfuzz import fuzz, process

RULES_VERSION = "rules-1.3"
DOC_TYPES = ["PAN_CARD", "AADHAAR_CARD", "ELECTRICITY_BILL", "BANK_STATEMENT", "DRIVING_LICENCE", "OTHER"]
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))

# ---------------------------------------------------------------- reference lexicons (no truth data used)
STATES = ["Andhra Pradesh", "Assam", "Bihar", "Delhi", "Goa", "Gujarat", "Haryana", "Karnataka", "Kerala", "Madhya Pradesh",
          "Maharashtra", "Odisha", "Punjab", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh", "Uttarakhand", "West Bengal"]
ADDRESS_WORDS = ["Flat", "Door", "House", "Plot", "No.", "Road", "Marg", "Street", "Lane", "Nagar", "Society", "Residency", "Heights",
                 "Towers", "Enclave", "Apartments", "Colony", "Park", "Green", "Lotus", "Palm", "Grove", "Coral", "Sunrise", "Ganga",
                 "Lake", "View", "Hill", "Temple", "Church", "Station", "Nehru", "Gandhi", "MG", "Main", "Cross", "Sector",
                 "Market", "Krupa", "Towers", "Apartments", "Sai"]


def _load_name_lexicon() -> set[str]:
    lex: set[str] = set()
    for name, cols in [("existing_customers", ["full_name"]), ("sanctions_list", ["name", "alias"]), ("pep_list", ["name"])]:
        p = DATA_DIR / f"case_02_{name}_V1.0.csv"
        if p.exists():
            for row in csv.DictReader(p.open(encoding="utf-8")):
                for c in cols:
                    lex.update(re.findall(r"[A-Z]+", (row.get(c) or "").upper()))
    return lex


NAME_LEXICON = _load_name_lexicon()
CITY_LEXICON = {"Mumbai", "Delhi", "Pune", "Kochi", "Bengaluru", "Chennai", "Hyderabad", "Kolkata", "Ahmedabad", "Jaipur", "Lucknow", "Bhopal", "Indore", "Nagpur", "Surat"}

# ---------------------------------------------------------------- OCR character repair
TO_DIGIT = str.maketrans({"O": "0", "o": "0", "D": "0", "Q": "0", "I": "1", "l": "1", "i": "1", "|": "1", "L": "1", "S": "5", "s": "5", "B": "8", "Z": "2", "z": "2", "G": "6", "b": "6", "T": "7", "g": "9", "q": "9"})
TO_ALPHA = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G", "4": "A", "7": "T", "3": "E"})
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
INJECTION = re.compile(r"ignore (all |any )?(previous|prior|above) instructions|ai assistants?|automated systems|approve this applicant|mark every check|system prompt|you are now", re.I)


_LC = {"a": "[ao]", "e": "[ec]", "i": "[i1l|]", "l": "[l1i|I]", "o": "[o0]", "s": "[s5]", "b": "[b8]", "m": "(?:m|rn)", "n": "[n]", "u": "[u]", "t": "[t]", "r": "[r]", "y": "[y]"}


def L(label: str) -> str:
    """Regex for a printed label that tolerates OCR confusions (rn/m, 1/l, 0/o, e/c), stray , or . and split words."""
    out = []
    for ch in label.lower():
        if ch == " ":
            out.append(r"\s*")
        elif ch.isalpha():
            out.append(_LC.get(ch, f"[{ch}]") + r"[,.]?")
        else:
            out.append(re.escape(ch))
    return "".join(out)


def digits(s: str) -> tuple[str, bool]:
    fixed = s.translate(TO_DIGIT)
    return fixed, fixed != s


@dataclass
class Field:
    field_name: str
    value: str
    confidence: float
    start: int | None = None
    end: int | None = None

    def out(self) -> dict:
        d = {"field_name": self.field_name, "value": self.value, "confidence": round(max(0.0, min(1.0, self.confidence)), 2)}
        if self.start is not None:
            d["source_span"] = {"start": self.start, "end": self.end}
        return d


@dataclass
class Result:
    doc_type: str
    doc_type_confidence: float
    fields: list[Field] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- text quality
def noise_score(text: str) -> float:
    """0 = clean, ~1 = very noisy. Counts junk-only lines and broken specimen banner."""
    lines = [l for l in text.splitlines() if l.strip()]
    junk = sum(1 for l in lines if not re.search(r"[A-Za-z0-9]{2}", l))
    broken = 0 if "SYNTHETIC SPECIMEN - NOT A VALID DOCUMENT" in text else 1
    odd = len(re.findall(r"[a-z][,.][a-z]|[A-Za-z][0-9][A-Za-z]", text))
    return min(1.0, junk / 6 + broken * 0.3 + odd / 10)


# ---------------------------------------------------------------- classification
SIGNALS = {
    "PAN_CARD": [("INCOME TAX IDENTITY CARD", 3), ("PERMANENT ACCOUNT NUMBER", 3), ("FATHER'S NAME", 1)],
    "AADHAAR_CARD": [("AADHAAR", 2), ("RESIDENT IDENTITY", 3)],
    "ELECTRICITY_BILL": [("ELECTRICITY BILL", 3), ("POWER DISTRIBUTION", 2), ("CONSUMER NO", 2), ("UNITS CONSUMED", 2), ("SUPPLY ADDRESS", 1)],
    "BANK_STATEMENT": [("ACCOUNT STATEMENT", 3), ("STATEMENT DATE", 2), ("BANK", 1)],
    "DRIVING_LICENCE": [("DRIVING LICENCE", 3), ("TRANSPORT DEPT", 2), ("DL NO", 2), ("VALID TILL", 2)],
}
# Structural anchors that a genuine document of the type must contain (keywords alone are not enough).
ANCHORS = {
    "PAN_CARD": re.compile(r"\b[A-Za-z0-9]{5}[0-9OILSBZl]{4}[A-Za-z0-9]\b"),
    "AADHAAR_CARD": re.compile(r"X[X .,]{5,12}[0-9OIlSB]{4}"),
    "ELECTRICITY_BILL": re.compile(r"\b(?:Bill\s*Date|kWh)\b", re.I),
    "BANK_STATEMENT": re.compile(r"Statement\s*Date|SALARY|UPI/", re.I),
    "DRIVING_LICENCE": re.compile(r"Valid\s*Ti[l1]{2}|DL\s*No", re.I),
}


def _line_hit(lines: list[str], kw: str) -> float:
    best = 0.0
    for l in lines:
        compact = re.sub(r"[^A-Z0-9' ]", "", l.upper())
        if kw in compact:
            return 100.0
        if len(compact) >= len(kw) * 0.6:
            best = max(best, fuzz.partial_ratio(kw, compact))
    return best


def classify(text: str) -> tuple[str, float, list[str]]:
    flags: list[str] = []
    if INJECTION.search(text):
        flags.append("PROMPT_INJECTION_TEXT")
        return "OTHER", 0.99, flags
    lines = [l for l in text.splitlines() if l.strip()]
    scores = {}
    for t, sigs in SIGNALS.items():
        s = 0.0
        for kw, w in sigs:
            h = _line_hit(lines, kw)
            if h >= 80:
                s += w * (h / 100)
        scores[t] = s
    best = max(scores, key=scores.get)
    ranked = sorted(scores.values(), reverse=True)
    top, second = ranked[0], ranked[1]
    if top < 2.5 or not ANCHORS[best].search(text):
        return "OTHER", 0.95 if top < 1 else 0.7, flags
    margin = (top - second) / top
    conf = 0.80 + 0.19 * margin
    if top < 4:
        conf -= 0.05
    return best, round(conf, 2), flags


# ---------------------------------------------------------------- field helpers
def norm_date(raw: str) -> tuple[str | None, bool]:
    s = raw.strip().strip(".")
    m = re.fullmatch(r"([0-9OoIlSBZ|]{1,2})\s*[/\-.]\s*([0-9OoIlSBZ|]{1,2})\s*[/\-.]\s*([0-9OoIlSBZ|]{4})", s)
    fixed = False
    if m:
        (d, f1), (mo, f2), (y, f3) = digits(m[1]), digits(m[2]), digits(m[3])
        fixed = f1 or f2 or f3
        try:
            return date(int(y), int(mo), int(d)).isoformat(), fixed
        except ValueError:
            return None, True
    m = re.fullmatch(r"([0-9OoIlSBZ|]{1,2})\s*-\s*([A-Za-z0-9 ]{3,4})\s*-\s*([0-9OoIlSBZ|]{4})", s)
    if m:
        (d, f1), (y, f3) = digits(m[1]), digits(m[3])
        mon_raw = m[2].replace(" ", "").upper().translate(TO_ALPHA)
        mon = process.extractOne(mon_raw, MONTHS, scorer=fuzz.ratio)
        if not mon or mon[1] < 60:
            return None, True
        fixed = f1 or f3 or mon_raw != mon[0] or m[2] != m[2].strip()
        try:
            return date(int(y), MONTHS.index(mon[0]) + 1, int(d)).isoformat(), fixed
        except ValueError:
            return None, True
    return None, False


DATE_RX = r"([0-9OoIlSBZ|]{1,2}\s*[/\-.]\s*(?:[0-9OoIlSBZ|]{1,2}|[A-Za-z0-9]{3,4})\s*[/\-.]\s*[0-9OoIlSBZ|]{4})"


def find_date(text: str, label_rx: str) -> tuple[str, bool, int, int] | None:
    m = re.search(label_rx + r"[\s:.\-]*" + DATE_RX, text, re.I)
    if not m:
        return None
    v, fixed = norm_date(m.group(1))
    return (v, fixed, m.start(1), m.end(1)) if v else None


def fix_pan(tok: str) -> tuple[str | None, bool]:
    if len(tok) != 10:
        return None, False
    t = tok.upper()
    fixed = t[:5].translate(TO_ALPHA) + digits(t[5:9])[0] + t[9].translate(TO_ALPHA)
    if re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", fixed):
        return fixed, fixed != t
    return None, False


def clean_name(raw: str, noisy: bool) -> tuple[str, float]:
    """Strip OCR debris from a name; repair unknown tokens against the reference name lexicon."""
    s = re.sub(r"(?<=[A-Za-z])[0-9]+|[0-9]+(?=[A-Za-z])", lambda m: m[0].translate(TO_ALPHA), raw)  # MEN0N -> MENON
    s = re.sub(r"[^A-Za-z .'-]", " ", s)
    s = re.sub(r"(?<=[A-Za-z])[.,](?=[A-Za-z])", "", s)
    tokens = [t.strip("'-") for t in re.split(r"\s+", s.replace(".", " ")) if t.strip("'-")]
    if noisy:  # re-join words split by the scan ("SIN GH" -> "SINGH") when the join is a known name
        i = 0
        while i < len(tokens) - 1:
            a, b = tokens[i].upper(), tokens[i + 1].upper()
            if (a + b) in NAME_LEXICON and not (a in NAME_LEXICON and b in NAME_LEXICON):
                tokens[i:i + 2] = [a + b]
            i += 1
    while tokens and len(tokens) > 1 and len(tokens[-1]) == 1 and noisy:  # stray trailing letter from scan debris
        tokens.pop()
    out, conf = [], 0.97
    for t in tokens:
        u = t.upper()
        if u in NAME_LEXICON or len(u) == 1 or ("-" in u and all(p in NAME_LEXICON for p in u.split("-"))):
            out.append(u)
            continue
        if not noisy:  # clean scan: trust the text, never "correct" a real but unfamiliar name
            out.append(u); conf = min(conf, 0.86)
            continue
        split = next(([u[:i], u[i:]] for i in range(2, len(u) - 1) if u[:i] in NAME_LEXICON and u[i:] in NAME_LEXICON), None)
        if split:  # merged tokens: RAVIPRASAD -> RAVI PRASAD
            out.extend(split); conf = min(conf, 0.82)
            continue
        u2 = u.replace("RN", "M")  # classic OCR m -> rn
        cand = process.extractOne(u2, NAME_LEXICON, scorer=fuzz.ratio) if NAME_LEXICON else None
        if cand and cand[1] >= 75 and abs(len(cand[0]) - len(u2)) <= 1:
            out.append(cand[0]); conf = min(conf, 0.82)
        else:
            out.append(u); conf = min(conf, 0.70)
    return " ".join("-".join(p.capitalize() for p in w.split("-")) for w in out), conf


def clean_address(raw: str) -> tuple[str, bool]:
    s = re.sub(r"\s*[~\"|]+\s*", " ", raw)
    s = re.sub(r"(?<=[a-z])[.,](?=[a-z])", "", s)       # "Soc.iety" -> "Society"
    s = re.sub(r"\s+", " ", s).strip(" ,-.")
    s = re.sub(r"\s*(,\s*)+", ", ", s)
    changed = s != re.sub(r"\s+", " ", raw).strip(" ,-.")
    parts = [p.strip() for p in s.split(",")]
    # Repair the trailing state and city with fuzzy lookup; join split words ("Koc hi") when that yields a known word.
    if len(parts) >= 3 and process.extractOne(parts[-2] + parts[-1], [x.replace(" ", "") for x in STATES], scorer=fuzz.ratio, score_cutoff=88):
        parts[-2:] = [parts[-2] + " " + parts[-1]]; changed = True  # "Uttar, Pradesh"
    if parts:
        st = process.extractOne(parts[-1].replace(" ", ""), {x: x.replace(" ", "") for x in STATES}, scorer=fuzz.ratio)
        if st and st[1] >= 75:
            changed |= parts[-1] != st[2]; parts[-1] = st[2]
    if len(parts) >= 2:
        ct = process.extractOne(parts[-2].replace(" ", ""), CITY_LEXICON, scorer=fuzz.ratio)
        if ct and ct[1] >= 80:
            changed |= parts[-2] != ct[0]; parts[-2] = ct[0]
    fixed_parts = []
    for p in parts:
        words = []
        for w in re.sub(r"\b(MG|DLF|BTM)(?=[A-Z][a-z])", r"\1 ", p).split(" "):
            if len(re.findall(r"[A-Za-z]", w)) >= 3 and len(re.findall(r"\d", w)) == 1 and not re.match(r"\d+[A-Z]?$", w):
                w = w.translate(str.maketrans({"5": "S" if w[0] == "5" else "s", "1": "l", "0": "o", "8": "B" if w[0] == "8" else "b"}))
                changed = True
            m = process.extractOne(w, ADDRESS_WORDS, scorer=fuzz.ratio) if len(w) >= 4 and not re.search(r"\d", w) else None
            if m and 75 <= m[1] < 100 and len(m[0]) == len(w):
                words.append(m[0]); changed = True
            else:
                words.append(w)
        fixed_parts.append(" ".join(words))
    s = ", ".join(fixed_parts)
    s = re.sub(r"\b(Door|House)No\.", r"\1 No.", s)
    s = re.sub(r"([a-z])([A-Z][a-z]{3,})", r"\1 \2", s)    # "GangaEnclave" -> "Ganga Enclave"
    s = re.sub(r"\b(?=[0-9OlIZS]*[0-9])([0-9OlIZS]{1,4})(?=,)", lambda m: digits(m[1])[0] if re.search(r"\d", m[1]) and re.fullmatch(r"[0-9OlIZS]+", m[1]) else m[1], s)
    s = re.sub(r"\b([0-9]+)[Z]\b", lambda m: m[1] + "2", s)
    return s, changed


def find_pincode(text: str, after: int = 0) -> tuple[str, bool, int, int] | None:
    for rx in [r"PIN\s*[:.\-]?\s*([0-9OoIlSB]{6})\b", r"-\s*([0-9OoIlSB]{6})\b", r"\b([1-9][0-9]{5})\b"]:
        for m in re.finditer(rx, text[after:], re.I):
            v, fixed = digits(m.group(1))
            if re.fullmatch(r"[1-9][0-9]{5}", v):
                return v, fixed, after + m.start(1), after + m.end(1)
    return None


def _line_after_label(text: str, label_rx: str, exclude_rx: str | None = None) -> tuple[str, int] | None:
    """Value on the same line after a label, or the next meaningful line."""
    for m in re.finditer(label_rx, text, re.I):
        line_start = text.rfind("\n", 0, m.start()) + 1
        if exclude_rx and re.search(exclude_rx, text[line_start:m.end()], re.I):
            continue
        pos = m.end()
        nl = text.find("\n", pos)
        rest = text[pos: nl if nl >= 0 else len(text)]
        if re.search(r"[A-Za-z]{2}", rest):
            off = pos + (len(rest) - len(rest.lstrip(" :.-")))
            return rest.strip(" :.-\t"), off
        while nl >= 0:
            nxt = text.find("\n", nl + 1)
            line = text[nl + 1: nxt if nxt >= 0 else len(text)]
            if re.search(r"[A-Za-z]{2}", line):
                return line.strip(), nl + 1 + (len(line) - len(line.lstrip()))
            nl = nxt
    return None


def _add(res: Result, name: str, value: str | None, conf: float, start: int | None = None, end: int | None = None):
    if value:
        res.fields.append(Field(name, value, conf, start, end))


# ---------------------------------------------------------------- per-type extraction
def _name_field(res, text, raw_off, noisy, penalty):
    if not raw_off:
        return
    raw, off = raw_off
    v, c = clean_name(raw, noisy)
    _add(res, "name", v, c - penalty, off, off + len(raw))


def extract_pan(text, res, noisy, pen):
    best = None
    for m in re.finditer(r"\b[A-Za-z0-9]{10}\b", text):
        v, fixed = fix_pan(m.group(0))
        if v and (best is None or (not fixed and best[1])):
            best = (v, fixed, m.start(), m.end())
    if best:
        _add(res, "pan_number", best[0], (0.84 if best[1] else 0.97) - pen, best[2], best[3])
    nm = _line_after_label(text, r"\bN[a-z]{1,2}m?e\b|\bNa[r]?n?e\b", r"Fath")
    if nm:  # stop at a trailing label merged on the same line
        nm = (re.split(r"\s+Fath", nm[0])[0], nm[1])
    _name_field(res, text, nm, noisy, pen)
    d = find_date(text, r"(?:" + L("date of birth") + r"|D[o0]te\s*of\s*[B8]irth|D[O0]B)")
    if d:
        _add(res, "dob", d[0], (0.85 if d[1] else 0.97) - pen, d[2], d[3])


def extract_aadhaar(text, res, noisy, pen):
    lines = text.splitlines(keepends=True)
    off = 0
    for l in lines:  # name: first line that is a plain personal name (after the banner lines)
        s = l.strip()
        s = re.split(r"\s+D[O0]B\b", s)[0]  # name and DOB merged on one line
        if s and not re.search(r"AADHAAR|SPECIMEN|IDENTITY|D[O0]B|Addr|MALE|XXXX|Hackathon", s, re.I) and re.fullmatch(r"[A-Za-z .,|'-]{3,}", s) and len(re.findall(r"[A-Za-z]{2,}", s)) >= 1:
            raw = re.sub(r"\s*\|\s*$", "", s)
            _name_field(res, text, (raw, off + l.find(s)), noisy, pen)
            break
        off += len(l)
    d = find_date(text, r"D[O0]B")
    if d:
        _add(res, "dob", d[0], (0.85 if d[1] else 0.97) - pen, d[2], d[3])
    g = re.search(r"\b(FEMALE|MALE|TRANSGENDER)\b", text, re.I)
    if g:
        _add(res, "gender", {"FEMALE": "F", "MALE": "M", "TRANSGENDER": "O"}[g[1].upper()], 0.96 - pen, g.start(1), g.end(1))
    a = re.search(r"X[X .,]{5,12}?([0-9OoIlSB]{4})\b", text)
    if a:
        v, fixed = digits(a[1])
        _add(res, "aadhaar_last4", v, (0.85 if fixed else 0.97) - pen, a.start(1), a.end(1))
    m = re.search(L("address") + r"\s*[:.]?\s*(.+?)\s*-?\s*[\n ]*-?\s*([0-9OoIlSB]{6})\b", text, re.I | re.S)
    if m:
        addr, changed = clean_address(m[1].replace("\n", " "))
        _add(res, "address", addr, (0.80 if changed else 0.93) - pen * 2, m.start(1), m.end(1))
        v, fixed = digits(m[2])
        if re.fullmatch(r"[1-9][0-9]{5}", v):
            _add(res, "pincode", v, (0.85 if fixed else 0.96) - pen, m.start(2), m.end(2))


def extract_bill(text, res, noisy, pen):
    _name_field(res, text, _line_after_label(text, L("consumer name") + r"\s*:?"), noisy, pen)
    d = find_date(text, L("bill date"))
    if d:
        _add(res, "document_date", d[0], (0.85 if d[1] else 0.97) - pen, d[2], d[3])
    m = re.search(L("supply address") + r"\s*:?\s*(.+?)[, ]*P[.,]?I[.,]?N\s*[:.]?\s*([0-9OoIlSB]{6})", text, re.I | re.S)
    if m:
        addr, changed = clean_address(m[1].replace("\n", " "))
        _add(res, "address", addr, (0.80 if changed else 0.93) - pen * 2, m.start(1), m.end(1))
        v, fixed = digits(m[2])
        _add(res, "pincode", v, (0.85 if fixed else 0.96) - pen, m.start(2), m.end(2))
    else:
        p = find_pincode(text)
        if p:
            _add(res, "pincode", p[0], 0.8 - pen, p[2], p[3])


ADDR_START = r"(?:Flat|Door|House|Plot|Shop|No\.?|#|\d)"


def extract_statement(text, res, noisy, pen):
    m = re.search(r"SPECIMEN\s*-\s*N[,.]?[O0]T\s*A\s*VALID\s*D[O0]CUME\s*NT[^\n]*\n", text, re.I)
    start = m.end() if m else 0
    pm = re.search(r"P[.,]?I[.,]?N\s*[:.]?\s*([0-9OoIlSB]{6})", text[start:], re.I)
    if pm:
        block_end = start + pm.start()
        block = text[start:block_end]
        # skip junk lines, then name = leading upper-case words; address = the rest up to PIN.
        lead = len(block) - len(block.lstrip(" \n.~\"|"))
        while True:
            mm = re.match(r"\s*(?:[.~\"|]+[ .~\"|]*)?\n", block[lead:])
            if not mm or mm.end() == 0:
                break
            lead += mm.end()
        body = block[lead:]
        nm = re.match(r"\s*([A-Z][A-Z .]+?)(?=\s+" + ADDR_START + r"|\s*\n)", body)
        if nm:
            v, c = clean_name(nm[1], noisy)
            _add(res, "name", v, c - pen, start + lead + nm.start(1), start + lead + nm.end(1))
            rest_off = start + lead + nm.end(1)
            addr_raw = text[rest_off:block_end]
            addr_raw_s = re.sub(r"[\n]+", " ", addr_raw)
            addr, changed = clean_address(addr_raw_s)
            if addr:
                s0 = rest_off + (len(addr_raw) - len(addr_raw.lstrip()))
                _add(res, "address", addr, (0.80 if changed else 0.93) - pen * 2, s0, block_end)
        v, fixed = digits(pm[1])
        _add(res, "pincode", v, (0.85 if fixed else 0.96) - pen, start + pm.start(1), start + pm.end(1))
    d = find_date(text, L("statement date"))
    if d:
        _add(res, "document_date", d[0], (0.85 if d[1] else 0.97) - pen, d[2], d[3])


def extract_dl(text, res, noisy, pen):
    _name_field(res, text, _line_after_label(text, r"\b" + L("name") + r"\s*:"), noisy, pen)
    d = find_date(text, r"D[O0]B")
    if d:
        _add(res, "dob", d[0], (0.85 if d[1] else 0.97) - pen, d[2], d[3])
    v = find_date(text, L("valid till"))
    if v:
        _add(res, "valid_until", v[0], (0.85 if v[1] else 0.97) - pen, v[2], v[3])
    m = re.search(L("address") + r"\s*:?\s*(.+?)[, ]*P[.,]?I[.,]?N\s*[:.]?\s*([0-9OoIlSB]{6})", text, re.I | re.S)
    if m:
        addr, changed = clean_address(m[1].replace("\n", " "))
        _add(res, "address", addr, (0.80 if changed else 0.93) - pen * 2, m.start(1), m.end(1))
        p, fixed = digits(m[2])
        _add(res, "pincode", p, (0.85 if fixed else 0.96) - pen, m.start(2), m.end(2))


EXTRACTORS = {"PAN_CARD": extract_pan, "AADHAAR_CARD": extract_aadhaar, "ELECTRICITY_BILL": extract_bill,
              "BANK_STATEMENT": extract_statement, "DRIVING_LICENCE": extract_dl}


def extract(text: str, ocr_confidence: float | None = None) -> Result:
    doc_type, conf, flags = classify(text)
    res = Result(doc_type, conf, flags=flags)
    if doc_type in EXTRACTORS:
        n = noise_score(text)
        noisy = n >= 0.35
        pen = round(min(0.08, n * 0.08), 3)  # small global penalty on noisy scans
        EXTRACTORS[doc_type](text, res, noisy, pen)
        if noisy:
            res.flags.append("POOR_SCAN")
    if ocr_confidence is not None:  # image input: scale by OCR engine confidence
        res.doc_type_confidence = round(res.doc_type_confidence * ocr_confidence, 2)
        for f in res.fields:
            f.confidence *= ocr_confidence
    return res
