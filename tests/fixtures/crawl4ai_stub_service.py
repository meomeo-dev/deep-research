import json
import os
import socketserver
import sys
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

SOCKET_ENV = "DEEP_RESEARCH_CRAWL4AI_SOCKET"
TOKEN_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN"
MANIFEST_ENV = "DEEP_RESEARCH_CRAWL4AI_MANIFEST_PATH"
ARCHIVE_PATH = "/archive"
READY_PATH = "/readyz"
HEALTH_PATH = "/healthz"

SOCKET_PATH = os.environ.get(SOCKET_ENV, "")
TOKEN = os.environ.get(TOKEN_ENV, "")
MANIFEST_PATH = os.environ.get(MANIFEST_ENV, "")
ARCHIVE_BODY = os.environ.get("DEEP_RESEARCH_TEST_ARCHIVE_BODY", "stub archive body")
ARCHIVE_SOURCE = os.environ.get(
    "DEEP_RESEARCH_TEST_ARCHIVE_SOURCE", "https://example.com/stub-canonical"
)
ARCHIVE_TITLE = os.environ.get(
    "DEEP_RESEARCH_TEST_ARCHIVE_TITLE", "Stub archived evidence"
)
ARCHIVE_SUMMARY = os.environ.get(
    "DEEP_RESEARCH_TEST_ARCHIVE_SUMMARY", "Stub archive summary"
)
ARCHIVE_FAILURE_REASON = os.environ.get("DEEP_RESEARCH_TEST_ARCHIVE_FAILURE_REASON", "")
ARCHIVE_FAILURE_STATUS = os.environ.get("DEEP_RESEARCH_TEST_ARCHIVE_FAILURE_STATUS", "502")


class ThreadingUnixHTTPServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    daemon_threads = True
    allow_reuse_address = False


class StubRequestHandler(BaseHTTPRequestHandler):
    server_version = "DeepResearchStub/0.1"

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorize():
            return
        if self.path == HEALTH_PATH:
            self._send_json(200, {"ok": True})
            return
        if self.path == READY_PATH:
            self._send_json(200, {"ok": True, "ready": True})
            return
        self._send_json(404, {"error": f"UNKNOWN_PATH: {self.path}", "ok": False})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorize():
            return
        if self.path != ARCHIVE_PATH:
            self._send_json(404, {"error": f"UNKNOWN_PATH: {self.path}", "ok": False})
            return
        if ARCHIVE_FAILURE_REASON:
            try:
                status_code = int(ARCHIVE_FAILURE_STATUS)
            except ValueError:
                status_code = 502
            self._send_json(
                status_code,
                {
                    "failureReason": ARCHIVE_FAILURE_REASON,
                    "ok": False,
                    "sourceUri": ARCHIVE_SOURCE,
                },
            )
            return
        self._send_json(
            200,
            {
                "body": ARCHIVE_BODY,
                "ok": True,
                "sourceUri": ARCHIVE_SOURCE,
                "summary": ARCHIVE_SUMMARY,
                "title": ARCHIVE_TITLE,
            },
        )

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _authorize(self) -> bool:
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send_json(401, {"error": "UNAUTHORIZED", "ok": False})
            return False
        return True

    def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def write_manifest() -> None:
    if not MANIFEST_PATH:
        return
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    payload = {
        "pid": os.getpid(),
        "protocolVersion": 1,
        "socketPath": SOCKET_PATH,
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    with tempfile.NamedTemporaryFile(
        "w", delete=False, dir=os.path.dirname(MANIFEST_PATH), encoding="utf-8"
    ) as handle:
        json.dump(payload, handle)
        temp_path = handle.name
    os.replace(temp_path, MANIFEST_PATH)


def validate_environment() -> None:
    if not SOCKET_PATH:
        raise RuntimeError(f"{SOCKET_ENV} is required")
    if not TOKEN:
        raise RuntimeError(f"{TOKEN_ENV} is required")


def main() -> int:
    try:
        validate_environment()
    except Exception as exc:
        print(f"STUB_SERVICE_INVALID_ENV: {exc}", file=sys.stderr)
        return 2

    server = ThreadingUnixHTTPServer(SOCKET_PATH, StubRequestHandler)
    os.chmod(SOCKET_PATH, 0o600)
    write_manifest()

    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
