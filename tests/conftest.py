"""Test setup: real PostgreSQL (meerpic's rule: SQLite would prove nothing about
row locks, JSONB, or the revision counter).

Point MEERPAD_TEST_DB at a throwaway database, e.g. the one `make test-db`
creates; without it the database tests skip.
"""

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_tmp = Path(tempfile.mkdtemp(prefix="meerpad-test-"))
os.environ["UPLOAD_DIR"] = str(_tmp / "uploads")
os.environ["IMPORT_DIR"] = str(_tmp / "imports")
os.environ["BASE_URL"] = "http://testserver"
os.environ["SMTP_HOST"] = ""
os.environ["SECRET_KEY"] = "test-secret"
os.environ["DEFAULT_WORKSPACES"] = "Work,Private"
if os.environ.get("MEERPAD_TEST_DB"):
    os.environ["DATABASE_URL"] = os.environ["MEERPAD_TEST_DB"]
else:
    os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://invalid@127.0.0.1:1/none")
