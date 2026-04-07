import asyncio
import json
import os
import socketserver
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any
from urllib.parse import urlparse

SOCKET_ENV = "DEEP_RESEARCH_CRAWL4AI_SOCKET"
TOKEN_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN"
MANIFEST_ENV = "DEEP_RESEARCH_CRAWL4AI_MANIFEST_PATH"
ARCHIVE_PATH = "/archive"
HEALTH_PATH = "/healthz"
READY_PATH = "/readyz"
SUMMARY_LIMIT = 280


@dataclass
class ServiceState:
    manifest_path: str
    ready: bool
    socket_path: str
    startup_error: str | None
    token: str


STATE = ServiceState(
    manifest_path=os.environ.get(MANIFEST_ENV, ""),
    ready=False,
    socket_path=os.environ.get(SOCKET_ENV, ""),
    startup_error=None,
    token=os.environ.get(TOKEN_ENV, ""),
)

try:
    from crawl4ai import AsyncWebCrawler
except Exception as exc:  # pragma: no cover - exercised via startup failure path
    AsyncWebCrawler = None  # type: ignore[assignment]
    STATE.startup_error = (
        "CRAWL4AI_IMPORT_FAILED: install crawl4ai and run crawl4ai-setup before using the managed sidecar. "
        f"Original error: {exc}"
    )


class ThreadingUnixHTTPServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    daemon_threads = True
    allow_reuse_address = False


class SidecarRequestHandler(BaseHTTPRequestHandler):
    server_version = "DeepResearchCrawl4AI/0.1"

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorize():
            return
        if self.path == HEALTH_PATH:
            self._send_json(200, {"ok": True})
            return
        if self.path == READY_PATH:
            if STATE.startup_error:
                self._send_json(
                    503, {"error": STATE.startup_error, "ok": False, "ready": False}
                )
                return
            self._send_json(200, {"ok": True, "ready": True})
            return
        self._send_json(404, {"error": f"UNKNOWN_PATH: {self.path}", "ok": False})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorize():
            return
        if self.path != ARCHIVE_PATH:
            self._send_json(404, {"error": f"UNKNOWN_PATH: {self.path}", "ok": False})
            return
        if STATE.startup_error:
            self._send_json(
                503,
                {"failureReason": STATE.startup_error, "ok": False, "sourceUri": ""},
            )
            return

        payload = self._read_json_body()
        if payload is None:
            return

        source_url = payload.get("sourceUrl")
        timeout_ms = payload.get("timeoutMs", 15000)
        if not isinstance(source_url, str) or not source_url.strip():
            self._send_json(400, {"error": "INVALID_SOURCE_URL", "ok": False})
            return
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            timeout_ms = 15000

        try:
            result = asyncio.run(crawl_archive(source_url.strip(), timeout_ms))
        except (
            Exception
        ) as exc:  # pragma: no cover - exercised in integration via failure payload
            self._send_json(
                500,
                {
                    "failureReason": f"CRAWL4AI_ARCHIVE_FAILED: {exc}",
                    "ok": False,
                    "sourceUri": source_url.strip(),
                },
            )
            return

        status = 200 if result.get("ok") else 502
        self._send_json(status, result)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _authorize(self) -> bool:
        expected = f"Bearer {STATE.token}"
        if not STATE.token or self.headers.get("Authorization") != expected:
            self._send_json(401, {"error": "UNAUTHORIZED", "ok": False})
            return False
        return True

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "INVALID_CONTENT_LENGTH", "ok": False})
            return None
        body = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            parsed = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "INVALID_JSON", "ok": False})
            return None
        if not isinstance(parsed, dict):
            self._send_json(400, {"error": "INVALID_JSON_OBJECT", "ok": False})
            return None
        return parsed

    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


async def crawl_archive(source_url: str, timeout_ms: int) -> dict[str, Any]:
    if AsyncWebCrawler is None:
        return {
            "failureReason": STATE.startup_error,
            "ok": False,
            "sourceUri": source_url,
        }

    async with AsyncWebCrawler() as crawler:
        result = await asyncio.wait_for(
            crawler.arun(url=source_url), timeout=max(timeout_ms / 1000, 1)
        )

    resolved_url = normalize_source_url(getattr(result, "url", None), source_url)
    if not getattr(result, "success", False):
        return {
            "failureReason": normalize_text(getattr(result, "error_message", None))
            or "CRAWL4AI_EMPTY_RESULT",
            "ok": False,
            "sourceUri": resolved_url,
        }

    body = extract_markdown_body(result)
    if not body:
        return {
            "failureReason": "CRAWL4AI_EMPTY_BODY",
            "ok": False,
            "sourceUri": resolved_url,
            "title": build_title(result, resolved_url),
        }

    return {
        "body": body,
        "ok": True,
        "sourceUri": resolved_url,
        "summary": build_summary(body),
        "title": build_title(result, resolved_url),
    }


def extract_markdown_body(result: Any) -> str:
    markdown = getattr(result, "markdown", None)
    if isinstance(markdown, str):
        return normalize_text(markdown)
    if markdown is not None:
        for attribute_name in (
            "markdown_with_citations",
            "fit_markdown",
            "raw_markdown",
        ):
            value = getattr(markdown, attribute_name, None)
            normalized = normalize_text(value)
            if normalized:
                return normalized
    return normalize_text(getattr(result, "cleaned_html", None)) or normalize_text(
        getattr(result, "html", None)
    )


def build_title(result: Any, source_url: str) -> str:
    metadata = getattr(result, "metadata", None)
    if isinstance(metadata, dict):
        metadata_title = normalize_text(metadata.get("title"))
        if metadata_title:
            return metadata_title
    parsed = urlparse(source_url)
    if parsed.netloc and parsed.path:
        return f"{parsed.netloc}{parsed.path.rstrip('/')}"
    if parsed.netloc:
        return parsed.netloc
    return source_url or "Archived evidence"


def build_summary(body: str) -> str:
    normalized = normalize_text(body)
    if len(normalized) <= SUMMARY_LIMIT:
        return normalized
    return f"{normalized[:SUMMARY_LIMIT - 1]}..."


def normalize_source_url(candidate: Any, fallback: str) -> str:
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return fallback


def normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split()).strip()


def write_manifest() -> None:
    if not STATE.manifest_path:
        return
    manifest = {
        "pid": os.getpid(),
        "protocolVersion": 1,
        "socketPath": STATE.socket_path,
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    os.makedirs(os.path.dirname(STATE.manifest_path), exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", delete=False, dir=os.path.dirname(STATE.manifest_path), encoding="utf-8"
    ) as handle:
        json.dump(manifest, handle)
        temp_path = handle.name
    os.replace(temp_path, STATE.manifest_path)


def validate_environment() -> None:
    if not STATE.socket_path:
        raise RuntimeError(f"{SOCKET_ENV} is required")
    if not STATE.token:
        raise RuntimeError(f"{TOKEN_ENV} is required")


def main() -> int:
    try:
        validate_environment()
    except Exception as exc:
        print(f"CRAWL4AI_SIDECAR_INVALID_ENV: {exc}", file=sys.stderr)
        return 2

    server = ThreadingUnixHTTPServer(STATE.socket_path, SidecarRequestHandler)
    os.chmod(STATE.socket_path, 0o600)
    if STATE.startup_error:
        print(STATE.startup_error, file=sys.stderr)
    write_manifest()
    STATE.ready = STATE.startup_error is None
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
