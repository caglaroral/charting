"""Minimal ClickHouse HTTP client (stdlib only). Uses server-side query parameters ({name:Type})
so user input is never interpolated into SQL.

`app` is the connection to the application database (users, drawings, alerts ...) configured in .env.
Market data sources are separate Client instances configured in the UI (see datasources.py)."""
import base64
import json
import urllib.error
import urllib.parse
import urllib.request

from . import config


class CHError(Exception):
    pass


class Client:
    def __init__(self, url: str, user: str, password: str, timeout: float = 60):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self._auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def _request(self, sql: str, params: dict | None = None, body: bytes | None = None, timeout: float | None = None) -> bytes:
        qs = {}
        for k, v in (params or {}).items():
            if isinstance(v, (list, tuple)):
                v = "[" + ",".join("'" + str(x).replace("\\", "\\\\").replace("'", "\\'") + "'" for x in v) + "]"
            qs[f"param_{k}"] = str(v)
        if body is None:
            data = sql.encode()
        else:
            qs["query"] = sql
            data = body
        url = self.url + "/?" + urllib.parse.urlencode(qs)
        req = urllib.request.Request(url, data=data, headers={"Authorization": self._auth})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise CHError(e.read().decode(errors="replace").strip()) from None
        except (urllib.error.URLError, OSError) as e:
            raise CHError(f"Connection error: {getattr(e, 'reason', e)}") from None

    def query(self, sql: str, params: dict | None = None, timeout: float | None = None) -> list[dict]:
        return json.loads(self._request(sql + "\nFORMAT JSON", params, timeout=timeout))["data"]

    def query_compact(self, sql: str, params: dict | None = None) -> list[list]:
        return json.loads(self._request(sql + "\nFORMAT JSONCompact", params))["data"]

    def execute(self, sql: str, params: dict | None = None) -> None:
        self._request(sql, params)

    def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        body = "\n".join(json.dumps(r, separators=(",", ":")) for r in rows).encode()
        self._request(f"INSERT INTO {table} FORMAT JSONEachRow", body=body)


app = Client(config.CH_URL, config.CH_USER, config.CH_PASSWORD)

# Module-level shortcuts for the application database
query = app.query
query_compact = app.query_compact
execute = app.execute
insert = app.insert


def quote_ident(name: str) -> str:
    """Quote a ClickHouse identifier (database/table/column) chosen in the UI."""
    return "`" + str(name).replace("\\", "\\\\").replace("`", "\\`") + "`"


def apply_schema() -> None:
    text = config.SCHEMA_FILE.read_text().replace("charting", config.CH_APP_DB)
    lines = [l for l in text.splitlines() if not l.strip().startswith("--")]
    for stmt in "\n".join(lines).split(";"):
        if stmt.strip():
            execute(stmt)
