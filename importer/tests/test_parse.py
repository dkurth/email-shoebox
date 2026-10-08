from build_fixtures import simple_message

from gmail2sqlite.parse import decode_bytes, html_to_text, labels_from_raw, parse_labels, parse_message


def test_simple_message_fields():
    pm = parse_message(
        simple_message(
            subject="Lunch?",
            body="Want to get lunch tomorrow?\n",
            to="Bob <BOB@Example.com>, carol@example.com",
            labels="Inbox,Unread,Important,Category Personal",
            extra_headers={"Cc": '"Doe, Jane" <jane@example.com>', "In-Reply-To": "<x@y>"},
        )
    )
    assert pm.subject == "Lunch?"
    assert pm.thread_id == "1000000000000000001"
    assert pm.message_id == "<m1@example.com>"
    assert pm.in_reply_to == "<x@y>"
    assert pm.from_.name == "Alice Example" and pm.from_.addr == "alice@example.com"
    assert [(a.name, a.addr) for a in pm.to] == [("Bob", "bob@example.com"), ("", "carol@example.com")]
    assert [(a.name, a.addr) for a in pm.cc] == [("Doe, Jane", "jane@example.com")]
    assert pm.date_utc == 1713929042
    assert pm.labels == ["Inbox", "Unread", "Important", "Category Personal"]
    assert pm.body_text == "Want to get lunch tomorrow?\n"
    assert pm.body_html is None
    assert pm.snippet == "Want to get lunch tomorrow?"
    assert pm.errors == []
    assert pm.headers_raw.startswith("X-GM-THRID: ")
    assert "\r" not in pm.headers_raw


def test_multipart_alternative_and_attachments():
    pm = parse_message(
        simple_message(
            body="plain version\n",
            html="<html><head><style>p{}</style></head><body><p>HTML <b>version</b></p></body></html>",
            attachments=[("report.pdf", "application/pdf", b"%PDF-1.4 fake"), ("notes.txt", "text/plain", b"a note")],
        )
    )
    assert pm.body_text == "plain version\n"
    assert "<b>version</b>" in pm.body_html
    assert [(a.index, a.filename, a.content_type, a.is_inline) for a in pm.attachments] == [
        (1, "report.pdf", "application/pdf", False),
        (2, "notes.txt", "text/plain", False),
    ]
    assert pm.attachments[0].data == b"%PDF-1.4 fake"
    assert pm.attachments[1].data == b"a note"  # a named text part is an attachment, not body


def test_html_only_message_gets_text_snippet():
    raw = (
        b"Subject: hi\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
        b"<html><script>var x=1;</script><body><div>Hello&nbsp;<i>world</i></div><div>Line two</div></body></html>\r\n"
    )
    pm = parse_message(raw)
    assert pm.body_text is None
    assert pm.body_html.startswith("<html>")
    assert pm.snippet == "Hello world Line two"
    assert "var x" not in pm.search_text


def test_encoded_words_and_charsets():
    raw = (
        b"Subject: =?iso-8859-1?q?Caf=E9_au_lait?=\r\n"
        b"From: =?utf-8?b?SsO8cmdlbiBNw7xsbGVy?= <j@example.de>\r\n"
        b"To: \"=?utf-8?q?M=C3=BCller=2C_Hans?=\" <h@example.de>\r\n"
        b"Content-Type: text/plain; charset=iso-8859-1\r\n"
        b"Content-Transfer-Encoding: quoted-printable\r\n\r\n"
        b"Gr=FC=DFe =93quoted=94\r\n"
    )
    pm = parse_message(raw)
    assert pm.subject == "Café au lait"
    assert pm.from_.name == "Jürgen Müller"
    assert pm.to[0].name == "Müller, Hans"
    assert pm.body_text == "Grüße “quoted”\n"  # iso-8859-1 decoded as Windows-1252


def test_raw_utf8_header_bytes():
    raw = "Subject: Grüße aus Köln\r\nFrom: Zoë <z@example.com>\r\n\r\nhi\r\n".encode("utf-8")
    pm = parse_message(raw)
    assert pm.subject == "Grüße aus Köln"
    assert pm.from_.name == "Zoë"


def test_unknown_and_wrong_charsets():
    assert decode_bytes("ok ✓".encode(), "x-made-up") == "ok ✓"
    assert decode_bytes("naïve".encode(), "us-ascii") == "naïve"  # mislabeled UTF-8
    assert decode_bytes(b"caf\xe9", None) == "café"  # not UTF-8: Windows-1252
    raw = b"Subject: x\r\nContent-Type: text/plain; charset=bogus-charset\r\n\r\nplain \xff text\r\n"
    pm = parse_message(raw)
    assert pm.body_text.startswith("plain ")
    assert pm.errors == []


def test_missing_headers():
    pm = parse_message(b"\r\nJust a body\r\n")
    assert pm.subject is None and pm.message_id is None and pm.date_utc is None and pm.from_ is None
    assert pm.body_text == "Just a body\n"


def test_bad_date_and_naive_date():
    assert parse_message(b"Date: not a date\r\n\r\nx").date_utc is None
    assert parse_message(b"Date: 24 Apr 2024 03:24:02\r\n\r\nx").date_utc == 1713929042


def test_broken_mime_does_not_raise():
    raw = (
        b"Subject: broken\r\nMIME-Version: 1.0\r\n"
        b'Content-Type: multipart/mixed; boundary="nope"\r\n\r\n'
        b"no boundaries here at all\r\n"
    )
    pm = parse_message(raw)
    assert pm.subject == "broken"
    raw2 = (
        b"Subject: bad base64\r\nContent-Type: application/pdf; name=x.pdf\r\n"
        b"Content-Transfer-Encoding: base64\r\n\r\n!!!not base64!!!\r\n"
    )
    pm2 = parse_message(raw2)
    assert pm2.attachments[0].filename == "x.pdf"


def test_inline_image_with_content_id_and_attached_email():
    raw = (
        b"Subject: pic\r\nMIME-Version: 1.0\r\n"
        b'Content-Type: multipart/mixed; boundary="B1"\r\n\r\n'
        b'--B1\r\nContent-Type: multipart/related; boundary="B2"\r\n\r\n'
        b'--B2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src="cid:img1@x">\r\n'
        b"--B2\r\nContent-Type: image/png\r\nContent-ID: <img1@x>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n"
        b"--B2--\r\n"
        b"--B1\r\nContent-Type: message/rfc822\r\n\r\n"
        b"Subject: inner\r\nFrom: x@example.com\r\n\r\ninner body text\r\n"
        b"--B1--\r\n"
    )
    pm = parse_message(raw)
    assert pm.body_html == '<img src="cid:img1@x">'
    img, eml = pm.attachments
    assert (img.content_type, img.content_id, img.is_inline, img.filename) == ("image/png", "img1@x", True, None)
    assert img.data == b"\x89PNG\r\n\x1a\n"
    assert eml.content_type == "message/rfc822"
    assert b"inner body text" in eml.data
    assert pm.body_text is None  # the attached email's text is not mixed into this body


def test_rfc2231_and_encoded_filenames():
    raw = (
        b"Subject: f\r\nMIME-Version: 1.0\r\n"
        b'Content-Type: multipart/mixed; boundary="B"\r\n\r\n'
        b"--B\r\nContent-Type: text/plain\r\n\r\nbody\r\n"
        b"--B\r\nContent-Type: application/octet-stream\r\n"
        b"Content-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf\r\n\r\nx\r\n"
        b'--B\r\nContent-Type: application/octet-stream; name="=?utf-8?q?na=C3=AFve.doc?="\r\n'
        b"Content-Disposition: attachment\r\n\r\ny\r\n"
        b"--B--\r\n"
    )
    pm = parse_message(raw)
    assert [a.filename for a in pm.attachments] == ["résumé.pdf", "naïve.doc"]


def test_labels():
    assert parse_labels('Inbox,"Work, Old",Opened') == ["Inbox", "Work, Old", "Opened"]
    assert parse_labels("=?UTF-8?Q?F=C3=A4mily?=,Inbox") == ["Fämily", "Inbox"]
    assert parse_labels(None) == []
    raw = b"X-Gmail-Labels: Inbox,\r\n Starred\r\nSubject: x\r\n\r\nX-Gmail-Labels: not a header\r\n"
    assert labels_from_raw(raw) == ["Inbox", "Starred"]


def test_html_to_text():
    assert html_to_text("<p>a</p><p>b<br>c</p>") == "a\nb\nc"
    assert html_to_text("<unclosed") == ""
