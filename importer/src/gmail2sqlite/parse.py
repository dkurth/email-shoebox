"""Turn one raw RFC 822 message into the fields stored in the database.

Real mailboxes contain broken charsets, raw 8-bit headers, undecodable
encoded-words and malformed MIME. The rule here is: never raise. Each field is
decoded as well as possible, and anything that went wrong is recorded in
``ParsedMessage.errors`` (stored as ``messages.parse_error``).

The ``compat32`` policy is used on purpose: it never raises on header access,
and we do our own decoding of raw header bytes (UTF-8 first, then Windows-1252)
and of charsets (with fallbacks for unknown or mislabeled ones).
"""

from __future__ import annotations

import csv
import email.utils
import re
from dataclasses import dataclass, field
from datetime import timezone
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesHeaderParser, BytesParser
from email.policy import compat32
from html.parser import HTMLParser

SNIPPET_CHARS = 200
SEARCH_TEXT_MAX_CHARS = 500_000  # cap on body text sent to the full-text index

_FOLD_RE = re.compile(r"\r?\n(?=[ \t])")
_WS_RE = re.compile(r"\s+")
_LIST_ID_RE = re.compile(r"^list-id:[ \t]*(.*(?:\n[ \t].*)*)", re.IGNORECASE | re.MULTILINE)
_HEADER_END_RE = re.compile(rb"\r?\n\r?\n")

# Charset labels seen in the wild, mapped to what Python should use.
# ISO-8859-1 is decoded as Windows-1252, which is what browsers and mail clients do.
_CHARSET_ALIASES = {
    "iso-8859-1": "cp1252",
    "iso8859-1": "cp1252",
    "latin1": "cp1252",
    "latin-1": "cp1252",
    "us-ascii": None,
    "ascii": None,
    "ansi_x3.4-1968": None,
    "x-unknown": None,
    "unknown": None,
    "unknown-8bit": None,
    "default": None,
    "utf8": "utf-8",
    "x-user-defined": None,
    "gb2312": "gb18030",
    "gbk": "gb18030",
    "ks_c_5601-1987": "cp949",
    "x-mac-roman": "mac_roman",
    "macintosh": "mac_roman",
}


@dataclass
class Address:
    name: str
    addr: str

    def as_dict(self) -> dict:
        return {"name": self.name, "addr": self.addr}


@dataclass
class AttachmentPart:
    index: int  # 1-based position among this message's attachments
    filename: str | None  # original, decoded name (unsanitized; may be None)
    content_type: str
    content_id: str | None  # without <>
    is_inline: bool
    data: bytes


@dataclass
class ParsedMessage:
    subject: str | None = None
    thread_id: str | None = None
    message_id: str | None = None
    in_reply_to: str | None = None
    references: str | None = None
    from_: Address | None = None
    to: list[Address] = field(default_factory=list)
    cc: list[Address] = field(default_factory=list)
    bcc: list[Address] = field(default_factory=list)
    reply_to: list[Address] = field(default_factory=list)
    date_utc: int | None = None
    date_raw: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    snippet: str | None = None
    search_text: str = ""  # body as plain text, for the full-text index
    headers_raw: str = ""
    list_id: str | None = None  # List-Id: the part in <>, lower-cased
    list_name: str | None = None  # List-Id: the decoded text before <>
    labels: list[str] = field(default_factory=list)
    attachments: list[AttachmentPart] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- decoding


def decode_bytes(data: bytes, charset: str | None = None) -> str:
    """Decode bytes using the declared charset, falling back to UTF-8, then Windows-1252."""
    cs = (charset or "").strip().strip("\"'").lower()
    cs = _CHARSET_ALIASES.get(cs, cs) or None
    if cs:
        try:
            return data.decode(cs)
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    if cs:
        try:
            return data.decode(cs, errors="replace")
        except LookupError:
            pass
    return data.decode("cp1252", errors="replace")


def _undo_surrogates(value: str) -> str:
    """The parser keeps raw 8-bit header bytes as surrogate escapes; decode them properly."""
    if any("\udc80" <= c <= "\udcff" for c in value):
        return decode_bytes(value.encode("ascii", "surrogateescape"))
    return value


def _unfold(value: str) -> str:
    return _FOLD_RE.sub("", value).strip()


def decode_words(value: str) -> str:
    """Decode RFC 2047 encoded-words (=?utf-8?q?...?=), tolerating bad charsets."""
    if "=?" not in value:
        return value
    try:
        parts = decode_header(value)
    except Exception:
        return value
    out = []
    for chunk, cs in parts:
        if isinstance(chunk, bytes):
            out.append(decode_bytes(chunk, cs))
        else:
            out.append(chunk)
    # decode_header drops whitespace between encoded and plain words inconsistently;
    # make_header gets that right when it can.
    try:
        return str(make_header(parts))
    except Exception:
        return "".join(out)


def _clean(s: str) -> str:
    return s.replace("\x00", "")


class _Headers:
    """Raw header access: first value, all values, decoded or not."""

    def __init__(self, msg: Message):
        self._items: list[tuple[str, str]] = []
        for name, value in msg.raw_items():
            v = value if isinstance(value, str) else str(value)
            self._items.append((name.lower(), _unfold(_undo_surrogates(v))))

    def all_raw(self, name: str) -> list[str]:
        name = name.lower()
        return [v for n, v in self._items if n == name]

    def raw(self, name: str) -> str | None:
        vals = self.all_raw(name)
        return vals[0] if vals else None

    def text(self, name: str) -> str | None:
        v = self.raw(name)
        return None if v is None else _clean(decode_words(v)).strip()


# ---------------------------------------------------------------- headers


def parse_addresses(raw_values: list[str]) -> list[Address]:
    if not raw_values:
        return []
    pairs = email.utils.getaddresses(raw_values)
    if pairs == [("", "")]:
        pairs = email.utils.getaddresses(raw_values, strict=False)
    out = []
    for name, addr in pairs:
        name = _clean(decode_words(name)).strip().strip('"').strip()
        addr = _clean(addr).strip().lower()
        if name or addr:
            out.append(Address(name, addr))
    return out


def parse_list_id(value: str | None) -> tuple[str | None, str | None]:
    """RFC 2919 List-Id: 'Name <id>' -> (id lower-cased, name). A value with no <> is all id."""
    if not value:
        return None, None
    v = _clean(decode_words(_unfold(value))).strip()
    m = re.search(r"<([^<>]*)>", v)
    if m:
        lid = m.group(1).strip().lower()
        name = v[: m.start()].strip().strip('"').strip()
    else:
        lid = v.strip().strip('"').strip().lower()
        name = ""
    if not lid:
        return None, None
    return lid, name or None


def list_id_from_headers(headers_raw: str | None) -> tuple[str | None, str | None]:
    """Find the first List-Id header in a stored header block (messages.headers_raw)."""
    m = _LIST_ID_RE.search(headers_raw or "")
    return parse_list_id(m.group(1)) if m else (None, None)


def parse_labels(value: str | None) -> list[str]:
    """X-Gmail-Labels is comma-separated; names containing commas are double-quoted."""
    if not value:
        return []
    value = decode_words(value)
    try:
        names = next(csv.reader([value], skipinitialspace=True))
    except Exception:
        names = value.split(",")
    seen, out = set(), []
    for n in (n.strip() for n in names):
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def parse_date(value: str | None) -> int | None:
    if not value:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if dt is None:
        return None
    try:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except (OverflowError, OSError, ValueError):
        return None


def split_headers(data: bytes) -> bytes:
    m = _HEADER_END_RE.search(data)
    return data[: m.start()] if m else data


def labels_from_raw(data: bytes) -> list[str]:
    """Read only X-Gmail-Labels, without parsing the body. Used to refresh labels on re-import."""
    try:
        msg = BytesHeaderParser(policy=compat32).parsebytes(split_headers(data) + b"\r\n\r\n")
        return parse_labels(_Headers(msg).raw("X-Gmail-Labels"))
    except Exception:
        return []


# ---------------------------------------------------------------- body


class _HTMLText(HTMLParser):
    _SKIP = {"script", "style", "head", "title"}
    _BLOCK = {"br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        elif tag in self._BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(html: str) -> str:
    try:
        p = _HTMLText()
        p.feed(html)
        p.close()
        text = "".join(p.out)
    except Exception:
        text = re.sub(r"<[^>]*>", " ", html)
    lines = (_WS_RE.sub(" ", line).strip() for line in text.splitlines())
    return "\n".join(line for line in lines if line)


def _part_text(part: Message) -> str:
    data = part.get_payload(decode=True)
    if not isinstance(data, bytes):
        data = str(part.get_payload() or "").encode("utf-8", "surrogateescape")
    text = decode_bytes(data, part.get_content_charset())
    return _clean(text.replace("\r\n", "\n"))


def _filename(part: Message) -> str | None:
    try:
        name = part.get_filename()
    except Exception:
        name = None
    if name is None:
        # Some old mailers only put the name on Content-Type.
        try:
            name = part.get_param("name")
            if isinstance(name, tuple):
                name = email.utils.collapse_rfc2231_value(name)
        except Exception:
            name = None
    if not name:
        return None
    name = _clean(decode_words(_undo_surrogates(str(name)))).strip()
    return name or None


def _serialize(msg: Message) -> bytes:
    try:
        return msg.as_bytes()
    except Exception:
        try:
            return msg.as_string().encode("utf-8", "surrogateescape")
        except Exception:
            return b""


def _walk(msg: Message, pm: ParsedMessage, texts: list[str], htmls: list[str]) -> None:
    def add_attachment(part: Message, data: bytes, filename: str | None, ctype: str) -> None:
        cid = None
        try:
            raw_cid = part.get("Content-ID")
            if raw_cid:
                cid = _undo_surrogates(str(raw_cid)).strip().strip("<>").strip() or None
        except Exception:
            pass
        disp = part.get_content_disposition()
        is_inline = disp == "inline" or (cid is not None and disp != "attachment")
        pm.attachments.append(
            AttachmentPart(
                index=len(pm.attachments) + 1,
                filename=filename,
                content_type=ctype,
                content_id=cid,
                is_inline=is_inline,
                data=data,
            )
        )

    def visit(part: Message) -> None:
        ctype = part.get_content_type()
        if part.get_content_maintype() == "message" and part.is_multipart():
            # An attached email (message/rfc822) or a bounce report: keep it as a file.
            payload = part.get_payload()
            if ctype in ("message/rfc822", "message/global") and isinstance(payload, list) and len(payload) == 1:
                data = _serialize(payload[0])
            else:
                data = b"\r\n\r\n".join(_serialize(p) for p in payload) if isinstance(payload, list) else b""
            add_attachment(part, data, _filename(part), ctype)
            return
        if part.is_multipart():
            payload = part.get_payload()
            for sub in payload if isinstance(payload, list) else []:
                visit(sub)
            return

        filename = _filename(part)
        disp = part.get_content_disposition()
        if ctype in ("text/plain", "text/html") and disp != "attachment" and not filename:
            (texts if ctype == "text/plain" else htmls).append(_part_text(part))
            return
        data = part.get_payload(decode=True)
        if not isinstance(data, bytes):
            data = b""
        add_attachment(part, data, filename, ctype)

    visit(msg)


# ---------------------------------------------------------------- main entry


def _record(pm: ParsedMessage, what: str, exc: BaseException) -> None:
    pm.errors.append(f"{what}: {type(exc).__name__}: {exc}"[:500])


def _set_list(pm: ParsedMessage, h: _Headers) -> None:
    pm.list_id, pm.list_name = parse_list_id(h.raw("List-Id"))


def parse_message(data: bytes) -> ParsedMessage:
    pm = ParsedMessage()
    pm.headers_raw = decode_bytes(split_headers(data)).replace("\r\n", "\n")

    try:
        msg = BytesParser(policy=compat32).parsebytes(data)
    except Exception as e:  # pragma: no cover - the parser is very forgiving
        _record(pm, "parse", e)
        pm.body_text = decode_bytes(data[len(split_headers(data)) :]).replace("\r\n", "\n").strip()
        pm.search_text = pm.body_text[:SEARCH_TEXT_MAX_CHARS]
        return pm

    h = _Headers(msg)
    for what, fn in (
        ("subject", lambda: setattr(pm, "subject", h.text("Subject"))),
        ("thread", lambda: setattr(pm, "thread_id", h.text("X-GM-THRID") or None)),
        ("message-id", lambda: setattr(pm, "message_id", h.text("Message-ID") or None)),
        ("in-reply-to", lambda: setattr(pm, "in_reply_to", h.text("In-Reply-To") or None)),
        ("references", lambda: setattr(pm, "references", h.text("References") or None)),
        ("labels", lambda: setattr(pm, "labels", parse_labels(h.raw("X-Gmail-Labels")))),
        ("list-id", lambda: _set_list(pm, h)),
        ("date", lambda: (setattr(pm, "date_raw", h.text("Date")), setattr(pm, "date_utc", parse_date(pm.date_raw)))),
    ):
        try:
            fn()
        except Exception as e:
            _record(pm, what, e)

    for attr, name in (("to", "To"), ("cc", "Cc"), ("bcc", "Bcc"), ("reply_to", "Reply-To")):
        try:
            setattr(pm, attr, parse_addresses(h.all_raw(name)))
        except Exception as e:
            _record(pm, name, e)
    try:
        froms = parse_addresses(h.all_raw("From"))
        pm.from_ = froms[0] if froms else None
    except Exception as e:
        _record(pm, "From", e)

    texts: list[str] = []
    htmls: list[str] = []
    try:
        _walk(msg, pm, texts, htmls)
    except Exception as e:
        _record(pm, "mime", e)
        if not texts and not htmls:
            texts.append(decode_bytes(data[len(split_headers(data)) :]).replace("\r\n", "\n"))

    pm.body_text = "\n\n".join(t for t in texts if t.strip()) or None
    pm.body_html = "\n".join(t for t in htmls if t.strip()) or None
    plain = pm.body_text or (html_to_text(pm.body_html) if pm.body_html else "")
    pm.search_text = plain[:SEARCH_TEXT_MAX_CHARS]
    snippet = _WS_RE.sub(" ", plain[:4000]).strip()
    pm.snippet = snippet[:SNIPPET_CHARS] or None
    return pm
