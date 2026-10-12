"""Opt-in: import a public sample of 3,266 real Enron emails (pytest -m enron).

Real mail finds parser problems that synthetic fixtures miss. The file is
downloaded once into tests/.cache/ and never committed.
"""

import sqlite3
import urllib.request
from pathlib import Path

import pytest

from gmail2sqlite.importer import ImportOptions, run_import

URL = "https://raw.githubusercontent.com/ivanhb/EMA/master/server/data/mbox/enron/mbox-enron-white-s-all.mbox"
EXPECTED = 3266
CACHE = Path(__file__).parent / ".cache" / "enron-white-s.mbox"


@pytest.mark.enron
def test_enron_sample(tmp_path):
    if not CACHE.exists():
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".part")
        urllib.request.urlretrieve(URL, tmp)
        tmp.rename(CACHE)

    res = run_import([str(CACHE)], ImportOptions(out_dir=tmp_path, quiet=True))
    assert res.status == "finished"
    conn = sqlite3.connect(tmp_path / "mail.db")
    n, errors, no_body, no_subject = conn.execute(
        "SELECT count(*), sum(parse_error IS NOT NULL), sum(body_text IS NULL AND body_html IS NULL), sum(subject IS NULL) FROM messages"
    ).fetchone()
    assert n == EXPECTED
    assert errors <= EXPECTED * 0.01
    assert no_body <= EXPECTED * 0.05
    # Not a Takeout export: IDs are content hashes and there are no labels or threads.
    assert conn.execute("SELECT count(*) FROM messages WHERE gmail_id NOT LIKE 'sha256-%'").fetchone()[0] == 0
    hits = conn.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH 'enron'").fetchone()[0]
    assert hits > 100
