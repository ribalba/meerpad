"""Application configuration.

meerpad is a hosted, multi-user service like meerato (not a single-user,
self-hosted install like meerpic or meercal), so it is configured the way
meerato is: environment variables, optionally from a ``.env`` file, with dev
defaults that work out of the box. Coolify sets the environment in its UI.
"""

from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    """Application configuration, overridable via environment variables or a .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Where the app is reachable from a browser. Used to build login + share links in
    # emails and the addresses of published websites (<base_url>/v/<name>), and its
    # host is what separates "the app" from a custom domain pointed at a published
    # website when a request comes in (see app/sites.py).
    base_url: str = "http://localhost:8050"

    # Secret used to sign login codes. CHANGE THIS in production.
    secret_key: str = "dev-insecure-secret-change-me"

    # Database (PostgreSQL). Override with DATABASE_URL; docker-compose points this
    # at the bundled "db" service.
    database_url: str = "postgresql+psycopg://meerpad:meerpad@localhost:5435/meerpad"

    # File uploads (images, PDFs, anything dropped into a page).
    upload_dir: Path = BASE_DIR / "data" / "uploads"
    max_upload_bytes: int = 50 * 1024 * 1024  # 50 MB per file
    # A Notion export zip can be large: the whole workspace with every attachment.
    max_import_bytes: int = 4 * 1024 * 1024 * 1024  # 4 GB
    import_dir: Path = BASE_DIR / "data" / "imports"

    # Workspaces a brand-new account starts with. Comma separated.
    default_workspaces: str = "Work,Private"

    # Auth token lifetimes (minutes). The emailed sign-in code shares the login TTL.
    login_token_ttl_minutes: int = 30
    session_ttl_minutes: int = 60 * 24 * 30  # 30 days

    # Wrong guesses before an emailed sign-in code is destroyed.
    login_code_max_attempts: int = 5

    # Sign-in rate limits, per email, over a rolling window (meerato's numbers).
    login_rate_max: int = 5
    verify_rate_max: int = 15
    login_rate_window_minutes: int = 15

    # SMTP. If smtp_host is empty, emails are printed to the console instead of sent.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    email_from: str = "hello@meerpad.com"

    # --- Published websites ---------------------------------------------------
    # Every published page is at <base_url>/v/<name>, which needs no DNS or proxy
    # setup at all. A custom domain can be pointed at a site on top of that: the
    # address its A record should name is shown in the publish dialog (purely
    # informational, the server never checks DNS).
    public_ip: str = ""

    # --- Remote URL fetching ---------------------------------------------------
    # "Download this pasted image/PDF link into the page" fetches a URL server-side.
    # Private, loopback and link-local addresses are refused unless this is set,
    # which only makes sense on a developer machine.
    fetch_allow_private: bool = False
    fetch_timeout_seconds: float = 20.0

    @property
    def app_host(self) -> str:
        """Host name of the app itself, lowercased, without port."""
        return (urlparse(self.base_url).hostname or "localhost").lower()

    @property
    def default_workspace_names(self) -> list[str]:
        return [n.strip() for n in self.default_workspaces.split(",") if n.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.import_dir.mkdir(parents=True, exist_ok=True)
    return settings
