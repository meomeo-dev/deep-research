import asyncio
import json
import os
import socketserver
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from importlib import import_module
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

SOCKET_ENV = "DEEP_RESEARCH_CRAWL4AI_SOCKET"
TOKEN_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN"
MANIFEST_ENV = "DEEP_RESEARCH_CRAWL4AI_MANIFEST_PATH"
ARCHIVE_PATH = "/archive"
HEALTH_PATH = "/healthz"
READY_PATH = "/readyz"
SUMMARY_LIMIT = 280
PROBE_TIMEOUT_SECONDS = 3
PROBE_BODY_LIMIT = 4096
PROBE_SUMMARY_LIMIT = 160
ANTIBOT_PREFIX = "CRAWL4AI_ANTIBOT_CHALLENGE:"
BROWSER_REQUIRED_PREFIX = "CRAWL4AI_BROWSER_REQUIRED:"
DOWNLOAD_REQUIRED_PREFIX = "CRAWL4AI_DOWNLOAD_REQUIRED:"
FALLBACK_TRIGGER_PREFIXES = (
    ANTIBOT_PREFIX,
    BROWSER_REQUIRED_PREFIX,
    DOWNLOAD_REQUIRED_PREFIX,
)
HTML_CONTENT_TYPES = ("text/html", "application/xhtml+xml")
ANTIBOT_TEXT_MARKERS = (
    "acw_sc__v2",
    "document.location.reload()",
    "just a moment",
    "access denied",
    "captcha",
)
BROWSER_REQUIRED_TEXT_MARKERS = (
    "browser required",
    "enable javascript",
    "javascript required",
    "please use a browser",
)
DOWNLOAD_REQUIRED_TEXT_MARKERS = (
    "download required",
    "direct download",
    "content-disposition: attachment",
)
BROWSER_FALLBACK_HEADLESS = True
BROWSER_FALLBACK_DELAY_BEFORE_HTML_SECONDS = 2.0
BROWSER_FALLBACK_FILE_PREFIX = "browser-session-"
BROWSER_FALLBACK_PREVIEW_FILENAME = "browser-preview.pdf"


@dataclass
class ServiceState:
    manifest_path: str
    ready: bool
    socket_path: str
    startup_error: str | None
    token: str


@dataclass
class FailureProbeEvidence:
    status_code: int | None
    content_type: str
    body_excerpt: str
    header_markers: tuple[str, ...]
    summary: str


STATE = ServiceState(
    manifest_path=os.environ.get(MANIFEST_ENV, ""),
    ready=False,
    socket_path=os.environ.get(SOCKET_ENV, ""),
    startup_error=None,
    token=os.environ.get(TOKEN_ENV, ""),
)

try:
    crawl4ai_module = import_module("crawl4ai")
    AsyncWebCrawler = getattr(crawl4ai_module, "AsyncWebCrawler")
    CrawlerRunConfig = getattr(crawl4ai_module, "CrawlerRunConfig")
except Exception as exc:  # pragma: no cover - exercised via startup failure path
    AsyncWebCrawler = None  # type: ignore[assignment]
    CrawlerRunConfig = None  # type: ignore[assignment]
    STATE.startup_error = (
        "CRAWL4AI_IMPORT_FAILED: install crawl4ai and run crawl4ai-setup "
        "before using the managed sidecar. "
        f"Original error: {exc}"
    )

BROWSER_FALLBACK_IMPORT_ERROR: str | None = None
try:
    crawl4ai_module = import_module("crawl4ai")
    async_strategy_module = import_module(
        "crawl4ai.async_crawler_strategy"
    )
    BrowserConfig = getattr(crawl4ai_module, "BrowserConfig")
    UndetectedAdapter = getattr(crawl4ai_module, "UndetectedAdapter")
    AsyncPlaywrightCrawlerStrategy = getattr(
        async_strategy_module,
        "AsyncPlaywrightCrawlerStrategy",
    )
except Exception as exc:  # pragma: no cover - exercised via fallback guard path
    BrowserConfig = None  # type: ignore[assignment]
    UndetectedAdapter = None  # type: ignore[assignment]
    AsyncPlaywrightCrawlerStrategy = None  # type: ignore[assignment]
    BROWSER_FALLBACK_IMPORT_ERROR = (
        "CRAWL4AI_BROWSER_FALLBACK_IMPORT_FAILED: install a crawl4ai "
        "version that provides "
        "BrowserConfig, UndetectedAdapter, and AsyncPlaywrightCrawlerStrategy. "
        f"Original error: {exc}"
    )

PDF_IMPORT_ERROR: str | None = None
try:
    pdf_module = import_module("crawl4ai.processors.pdf")
    PDFContentScrapingStrategy = getattr(
        pdf_module,
        "PDFContentScrapingStrategy",
    )
    PDFCrawlerStrategy = getattr(pdf_module, "PDFCrawlerStrategy")
except Exception as exc:  # pragma: no cover - exercised via PDF routing path
    PDFContentScrapingStrategy = None  # type: ignore[assignment]
    PDFCrawlerStrategy = None  # type: ignore[assignment]
    PDF_IMPORT_ERROR = (
        "CRAWL4AI_PDF_IMPORT_FAILED: install a crawl4ai version that provides "
        "PDFCrawlerStrategy and PDFContentScrapingStrategy. "
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
        return build_failure_result(source_url, STATE.startup_error)

    timeout_seconds = max(timeout_ms / 1000, 1)
    if is_pdf_source_url(source_url):
        if PDF_IMPORT_ERROR:
            return build_failure_result(source_url, PDF_IMPORT_ERROR)
        result = await crawl_pdf_result(source_url, timeout_seconds)
    else:
        result = await crawl_html_result(source_url, timeout_seconds)

    resolved_url = normalize_source_url(getattr(result, "url", None), source_url)
    if not getattr(result, "success", False):
        failure_reason = await classify_failure_reason(
            source_url=source_url,
            probe_url=resolved_url,
            raw_reason=getattr(result, "error_message", None),
        )
        if is_pdf_source_url(source_url) and should_attempt_browser_pdf_fallback(
            failure_reason
        ):
            return await try_browser_pdf_download_fallback(
                source_url=source_url,
                timeout_seconds=timeout_seconds,
                original_failure_reason=failure_reason,
                resolved_source_url=resolved_url,
            )
        return build_failure_result(resolved_url, failure_reason)

    body = extract_markdown_body(result)
    if not body:
        return build_failure_result(
            resolved_url,
            "CRAWL4AI_EMPTY_BODY",
            title=build_title(result, resolved_url),
        )

    return build_success_result(result, resolved_url, body)


async def crawl_pdf_result(source_url: str, timeout_seconds: float) -> Any:
    async with AsyncWebCrawler(crawler_strategy=PDFCrawlerStrategy()) as crawler:
        return await asyncio.wait_for(
            crawler.arun(
                url=source_url,
                config=CrawlerRunConfig(
                    scraping_strategy=PDFContentScrapingStrategy()
                ),
            ),
            timeout=timeout_seconds,
        )


async def crawl_html_result(source_url: str, timeout_seconds: float) -> Any:
    async with AsyncWebCrawler() as crawler:
        return await asyncio.wait_for(
            crawler.arun(url=source_url),
            timeout=timeout_seconds,
        )


async def try_browser_pdf_download_fallback(
    source_url: str,
    timeout_seconds: float,
    original_failure_reason: str,
    resolved_source_url: str,
) -> dict[str, Any]:
    if BROWSER_FALLBACK_IMPORT_ERROR:
        return build_failure_result(
            resolved_source_url,
            append_browser_fallback_summary(
                original_failure_reason,
                BROWSER_FALLBACK_IMPORT_ERROR,
            ),
        )

    try:
        with tempfile.TemporaryDirectory(
            prefix="crawl4ai-pdf-download-"
        ) as download_dir:
            session_id = build_browser_fallback_session_id()
            browser_config = BrowserConfig(
                accept_downloads=True,
                downloads_path=download_dir,
                enable_stealth=True,
                headless=BROWSER_FALLBACK_HEADLESS,
            )
            crawler_strategy = AsyncPlaywrightCrawlerStrategy(
                browser_config=browser_config,
                browser_adapter=UndetectedAdapter(),
            )
            async with AsyncWebCrawler(
                crawler_strategy=crawler_strategy,
                config=browser_config,
            ) as crawler:
                browser_result = await asyncio.wait_for(
                    crawler.arun(
                        url=source_url,
                        config=CrawlerRunConfig(
                            pdf=True,
                            magic=True,
                            session_id=session_id,
                            simulate_user=True,
                            wait_until="load",
                            delay_before_return_html=BROWSER_FALLBACK_DELAY_BEFORE_HTML_SECONDS,
                            max_retries=1,
                        ),
                    ),
                    timeout=timeout_seconds,
                )

                browser_source_url = normalize_source_url(
                    getattr(browser_result, "url", None),
                    resolved_source_url,
                )
                downloaded_file = select_downloaded_file(
                    getattr(browser_result, "downloaded_files", None)
                )
                if not downloaded_file:
                    downloaded_file = await download_pdf_in_browser_session(
                        crawler_strategy,
                        session_id,
                        browser_source_url,
                        download_dir,
                    )
                if not downloaded_file:
                    downloaded_file = persist_preview_pdf_file(
                        browser_result,
                        download_dir,
                    )

            if not downloaded_file:
                return build_failure_result(
                    browser_source_url,
                    append_browser_fallback_summary(
                        original_failure_reason,
                        build_browser_fallback_summary(
                            browser_result,
                            "no downloaded files",
                        ),
                    ),
                )

            pdf_result = await crawl_pdf_result(
                Path(downloaded_file).resolve().as_uri(),
                timeout_seconds,
            )
            if not getattr(pdf_result, "success", False):
                fallback_body, fallback_title = extract_local_pdf_text_with_pypdf(
                    downloaded_file
                )
                if fallback_body:
                    return build_success_result(
                        build_pdf_fallback_result(fallback_title),
                        browser_source_url,
                        fallback_body,
                    )
                local_parse_reason = (
                    normalize_text(getattr(pdf_result, "error_message", None))
                    or "CRAWL4AI_EMPTY_RESULT"
                )
                return build_failure_result(
                    browser_source_url,
                    append_browser_fallback_summary(
                        original_failure_reason,
                        "downloaded "
                        f"{Path(downloaded_file).name}; local pdf parse "
                        f"failed: {local_parse_reason}",
                    ),
                )

            body = extract_markdown_body(pdf_result)
            if not body:
                fallback_body, fallback_title = extract_local_pdf_text_with_pypdf(
                    downloaded_file
                )
                if fallback_body:
                    return build_success_result(
                        build_pdf_fallback_result(fallback_title),
                        browser_source_url,
                        fallback_body,
                    )
                return build_failure_result(
                    browser_source_url,
                    append_browser_fallback_summary(
                        original_failure_reason,
                        "downloaded "
                        f"{Path(downloaded_file).name}; local pdf parse "
                        "returned empty body",
                    ),
                    title=build_title(pdf_result, browser_source_url),
                )
            return build_success_result(pdf_result, browser_source_url, body)
    except Exception as exc:
        return build_failure_result(
            resolved_source_url,
            append_browser_fallback_summary(
                original_failure_reason,
                f"browser fallback failed: {exc}",
            ),
        )


def build_success_result(result: Any, source_uri: str, body: str) -> dict[str, Any]:
    return {
        "body": body,
        "ok": True,
        "sourceUri": source_uri,
        "summary": build_summary(body),
        "title": build_title(result, source_uri),
    }


def build_failure_result(
    source_uri: str,
    failure_reason: str | None,
    title: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "failureReason": failure_reason or "CRAWL4AI_UNKNOWN_FAILURE",
        "ok": False,
        "sourceUri": source_uri,
    }
    if title:
        payload["title"] = title
    return payload


async def classify_failure_reason(
    source_url: str, probe_url: str, raw_reason: Any
) -> str:
    original_reason = normalize_text(raw_reason) or "CRAWL4AI_EMPTY_RESULT"
    if has_failure_prefix(original_reason):
        return original_reason

    probe = await try_run_failure_probe(probe_url)
    classification = classify_failure_kind(
        source_url=source_url,
        text=original_reason,
        content_type=probe.content_type if probe else "",
        body_excerpt=probe.body_excerpt if probe else "",
        header_markers=probe.header_markers if probe else (),
    )
    if classification:
        probe_summary = probe.summary if probe else None
        return format_classified_failure(
            classification,
            original_reason,
            probe_summary,
        )
    return original_reason


async def try_run_failure_probe(
    probe_url: str,
) -> FailureProbeEvidence | None:
    if not is_probe_candidate_url(probe_url):
        return None
    try:
        return await asyncio.to_thread(run_failure_probe, probe_url)
    except Exception:
        return None


def has_failure_prefix(reason: str) -> bool:
    return reason.startswith(FALLBACK_TRIGGER_PREFIXES)


def should_attempt_browser_pdf_fallback(reason: str) -> bool:
    return reason.startswith(FALLBACK_TRIGGER_PREFIXES)


def append_browser_fallback_summary(
    original_failure_reason: str, fallback_summary: str
) -> str:
    normalized_summary = normalize_text(fallback_summary)
    if not normalized_summary:
        return original_failure_reason
    return f"{original_failure_reason} | browser-fallback: {normalized_summary}"


def build_browser_fallback_summary(result: Any, detail: str) -> str:
    downloaded_files = normalize_downloaded_files(
        getattr(result, "downloaded_files", None)
    )
    parts = [detail, f"downloaded_files={len(downloaded_files)}"]
    status_code = getattr(result, "status_code", None)
    if isinstance(status_code, int):
        parts.append(f"status_code={status_code}")
    response_content_type = extract_result_content_type(result)
    if response_content_type:
        parts.append(f"response_content_type={response_content_type}")
    preview_pdf_bytes = extract_preview_pdf_bytes(result)
    if preview_pdf_bytes is not None:
        parts.append(f"preview_pdf_bytes={len(preview_pdf_bytes)}")
    error_message = normalize_text(getattr(result, "error_message", None))
    if error_message:
        parts.append(error_message)
    if downloaded_files:
        parts.append(f"first_file={Path(downloaded_files[0]).name}")
    return " ; ".join(parts)


def normalize_downloaded_files(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    files: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            files.append(item.strip())
    return files


def select_downloaded_file(value: Any) -> str | None:
    downloaded_files = normalize_downloaded_files(value)
    existing_files = [
        file_path for file_path in downloaded_files if os.path.isfile(file_path)
    ]
    if not existing_files:
        return None
    for file_path in existing_files:
        if file_path.lower().endswith(".pdf"):
            return file_path
    return existing_files[0]


def extract_browser_session_context(
    crawler_strategy: Any,
    session_id: str,
) -> Any | None:
    sessions = getattr(
        getattr(crawler_strategy, "browser_manager", None),
        "sessions",
        None,
    )
    if not isinstance(sessions, dict):
        return None
    session_value = sessions.get(session_id)
    if not isinstance(session_value, tuple) or not session_value:
        return None
    context = session_value[0]
    request_client = getattr(context, "request", None)
    if request_client is None or not hasattr(request_client, "get"):
        return None
    return context


async def download_pdf_in_browser_session(
    crawler_strategy: Any,
    session_id: str,
    source_url: str,
    download_dir: str,
) -> str | None:
    context = extract_browser_session_context(crawler_strategy, session_id)
    if context is None:
        return None
    try:
        response = await context.request.get(source_url)
        pdf_bytes = await response.body()
    except Exception:
        return None
    if response.status != 200:
        return None
    content_type = extract_header_value(response.headers, "content-type")
    if "application/pdf" not in content_type.lower() and not looks_like_pdf_bytes(
        pdf_bytes
    ):
        return None
    file_name = build_browser_fallback_filename(source_url)
    output_path = Path(download_dir) / file_name
    output_path.write_bytes(pdf_bytes)
    return str(output_path)


def build_browser_fallback_filename(source_url: str) -> str:
    parsed = urlparse(source_url)
    candidate_name = Path(parsed.path).name.strip()
    if candidate_name.lower().endswith(".pdf"):
        return candidate_name
    return f"{BROWSER_FALLBACK_FILE_PREFIX}{os.urandom(4).hex()}.pdf"


def build_browser_fallback_session_id() -> str:
    return f"pdf-inline-{os.getpid()}-{os.urandom(4).hex()}"


def looks_like_pdf_bytes(value: bytes) -> bool:
    return value.startswith(b"%PDF")


def extract_local_pdf_text_with_pypdf(
    local_pdf_path: str,
) -> tuple[str, str | None]:
    try:
        PdfReader = getattr(import_module("pypdf"), "PdfReader")
    except Exception:
        return ("", None)

    try:
        reader = PdfReader(local_pdf_path)
    except Exception:
        return ("", None)

    title = normalize_pdf_metadata_title(getattr(reader, "metadata", None))
    page_texts: list[str] = []
    for page in reader.pages:
        try:
            extracted_text = page.extract_text() or ""
        except Exception:
            extracted_text = ""
        normalized_text = extracted_text.strip()
        if normalized_text:
            page_texts.append(normalized_text)

    if not page_texts:
        return ("", title)
    return ("\n\n".join(page_texts), title)


def normalize_pdf_metadata_title(metadata: Any) -> str | None:
    if metadata is None:
        return None
    metadata_title = None
    if isinstance(metadata, dict):
        metadata_title = metadata.get("/Title") or metadata.get("Title")
    else:
        metadata_title = getattr(metadata, "title", None)
    normalized_title = normalize_text(metadata_title)
    if normalized_title:
        return normalized_title
    return None


def build_pdf_fallback_result(title: str | None) -> Any:
    metadata: dict[str, str] = {}
    if title:
        metadata["title"] = title
    return type(
        "PdfFallbackResult",
        (),
        {"metadata": metadata},
    )()


def persist_preview_pdf_file(result: Any, download_dir: str) -> str | None:
    preview_pdf_bytes = extract_preview_pdf_bytes(result)
    if preview_pdf_bytes is None:
        return None
    if not is_preview_pdf_candidate(result):
        return None
    preview_path = Path(download_dir) / BROWSER_FALLBACK_PREVIEW_FILENAME
    preview_path.write_bytes(preview_pdf_bytes)
    return str(preview_path)


def extract_preview_pdf_bytes(result: Any) -> bytes | None:
    preview_pdf = getattr(result, "pdf", None)
    if isinstance(preview_pdf, bytes) and preview_pdf:
        return preview_pdf
    if isinstance(preview_pdf, bytearray) and preview_pdf:
        return bytes(preview_pdf)
    return None


def is_preview_pdf_candidate(result: Any) -> bool:
    response_content_type = extract_result_content_type(result)
    if response_content_type and "application/pdf" in response_content_type.lower():
        return True
    for candidate in (
        getattr(result, "url", None),
        getattr(result, "redirected_url", None),
    ):
        normalized_candidate = normalize_source_url(candidate, "")
        if normalized_candidate and is_pdf_source_url(normalized_candidate):
            return True
    return False


def extract_result_content_type(result: Any) -> str:
    response_headers = getattr(result, "response_headers", None)
    if not isinstance(response_headers, dict):
        return ""
    return extract_header_value(response_headers, "content-type")


def extract_header_value(headers: Any, header_name: str) -> str:
    if not isinstance(headers, dict):
        return ""
    lowered_target = header_name.lower()
    for candidate_name, candidate_value in headers.items():
        if not isinstance(candidate_name, str):
            continue
        if candidate_name.lower() != lowered_target:
            continue
        normalized_value = normalize_text(candidate_value)
        if normalized_value:
            return normalized_value
    return ""


def is_probe_candidate_url(source_url: str) -> bool:
    parsed = urlparse(source_url)
    return parsed.scheme in {"http", "https"}


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


def classify_failure_kind(
    source_url: str,
    text: str,
    content_type: str,
    body_excerpt: str,
    header_markers: tuple[str, ...],
) -> str | None:
    combined_text = " ".join(part for part in (text, body_excerpt) if part).lower()
    normalized_content_type = content_type.lower()

    if any("denied by bot" in marker.lower() for marker in header_markers):
        return ANTIBOT_PREFIX
    if any(marker in combined_text for marker in ANTIBOT_TEXT_MARKERS):
        return ANTIBOT_PREFIX
    if any(marker in combined_text for marker in BROWSER_REQUIRED_TEXT_MARKERS):
        return BROWSER_REQUIRED_PREFIX
    if any(marker in combined_text for marker in DOWNLOAD_REQUIRED_TEXT_MARKERS):
        return DOWNLOAD_REQUIRED_PREFIX
    if is_pdf_source_url(source_url) and is_html_content_type(normalized_content_type):
        return DOWNLOAD_REQUIRED_PREFIX
    return None


def is_html_content_type(content_type: str) -> bool:
    return any(marker in content_type for marker in HTML_CONTENT_TYPES)


def format_classified_failure(
    prefix: str, original_reason: str, probe_summary: str | None = None
) -> str:
    if not probe_summary:
        return f"{prefix} {original_reason}"
    return f"{prefix} {original_reason} | probe: {probe_summary}"


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


def run_failure_probe(source_url: str) -> FailureProbeEvidence | None:
    head_status, head_content_type, header_markers = probe_headers(source_url)
    body_excerpt = ""
    if not header_markers and (
        not head_content_type or is_html_content_type(head_content_type)
    ):
        body_excerpt = probe_body_excerpt(source_url)
    summary = build_probe_summary(
        status_code=head_status,
        content_type=head_content_type,
        header_markers=header_markers,
        body_excerpt=body_excerpt,
    )
    if not summary:
        return None
    return FailureProbeEvidence(
        status_code=head_status,
        content_type=head_content_type,
        body_excerpt=body_excerpt,
        header_markers=header_markers,
        summary=summary,
    )


def probe_headers(source_url: str) -> tuple[int | None, str, tuple[str, ...]]:
    request = Request(source_url, headers=build_probe_headers(), method="HEAD")
    try:
        with urlopen(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            return extract_probe_headers(response.status, response.headers)
    except HTTPError as exc:
        return extract_probe_headers(exc.code, exc.headers)
    except (URLError, OSError, ValueError):
        return (None, "", ())


def probe_body_excerpt(source_url: str) -> str:
    request = Request(source_url, headers=build_probe_headers(), method="GET")
    try:
        with urlopen(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            body = response.read(PROBE_BODY_LIMIT)
    except HTTPError as exc:
        body = exc.read(PROBE_BODY_LIMIT)
    except (URLError, OSError, ValueError):
        return ""
    return normalize_text(body.decode("utf-8", errors="ignore"))


def normalize_source_url(candidate: Any, fallback: str) -> str:
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    return fallback


def build_probe_headers() -> dict[str, str]:
    return {
        "Accept": "text/html,application/pdf,*/*;q=0.1",
        "Range": f"bytes=0-{PROBE_BODY_LIMIT - 1}",
        "User-Agent": "DeepResearchCrawl4AI/0.1",
    }


def extract_probe_headers(
    status_code: int | None, headers: Any
) -> tuple[int | None, str, tuple[str, ...]]:
    if headers is None:
        return (status_code, "", ())
    content_type = normalize_text(headers.get("Content-Type", ""))
    header_markers: list[str] = []
    tengine_error = normalize_text(headers.get("x-tengine-error", ""))
    if tengine_error:
        header_markers.append(f"x-tengine-error={tengine_error}")
    return (status_code, content_type, tuple(header_markers))


def build_probe_summary(
    status_code: int | None,
    content_type: str,
    header_markers: tuple[str, ...],
    body_excerpt: str,
) -> str:
    parts: list[str] = []
    if status_code is not None:
        parts.append(f"status={status_code}")
    if content_type:
        parts.append(f"content-type={content_type}")
    parts.extend(header_markers)
    if body_excerpt:
        parts.append(f"body={body_excerpt[:PROBE_SUMMARY_LIMIT]}")
    return " ; ".join(parts)


def is_pdf_source_url(source_url: str) -> bool:
    parsed = urlparse(source_url)
    normalized_path = parsed.path.strip().lower().rstrip("/")
    return normalized_path.endswith(".pdf")


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
