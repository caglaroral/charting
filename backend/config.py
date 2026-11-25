"""Configuration from environment variables, with optional .env file in the project root."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

CH_URL = os.environ.get("CH_URL", "http://127.0.0.1:8123").rstrip("/")
CH_USER = os.environ.get("CH_USER", "default")
CH_PASSWORD = os.environ.get("CH_PASSWORD", "")
CH_APP_DB = os.environ.get("CH_APP_DB", "charting")
CH_MARKET_DB = os.environ.get("CH_MARKET_DB", "default")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

AUTH_MODE = os.environ.get("AUTH_MODE", "local")
AUTH_HEADER_USER = os.environ.get("AUTH_HEADER_USER", "X-Auth-Request-User")
AUTH_HEADER_EMAIL = os.environ.get("AUTH_HEADER_EMAIL", "X-Auth-Request-Email")
AUTH_HEADER_PROVIDER = os.environ.get("AUTH_HEADER_PROVIDER", "proxy")
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))

STATIC_DIR = ROOT / "static"
SCHEMA_FILE = ROOT / "sql" / "schema.sql"
