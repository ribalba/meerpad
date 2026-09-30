"""Fetch a URL someone pasted, server-side, without becoming an SSRF proxy.

Pasting a link to an image or PDF offers to download it into the page. The
server does the download (the browser could not: CORS), which means a signed-in
user can make the server request any URL. On a host running other containers,
"any URL" includes the database and every internal admin page, so:

* only http and https, on the usual ports or any port >= 1024;
* every address a name resolves to must be public: no loopback, private,
  link-local (cloud metadata lives there), multicast or reserved ranges;
* the check happens at *connect time*, on the address actually connected to.
  Resolving once up front and letting the HTTP client resolve again is the
  classic DNS-rebinding hole: the second answer can be 127.0.0.1. The guarded
  network backend below resolves, checks, and connects to that same address,
  while TLS still verifies against the original host name;
* redirects are followed by hand (at most 5), each one through the same guard;
* the body is streamed with a hard size cap and a timeout.

``fetch_allow_private`` turns the address check off for a developer machine.
"""

import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlparse

import httpcore

from .config import get_settings

settings = get_settings()

USER_AGENT = "meerpad/1.0 (+https://meerpad.com)"
MAX_REDIRECTS = 5


class FetchError(Exception):
    pass


def _check_ip(ip: str) -> None:
    if settings.fetch_allow_private:
        return
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
            or addr.is_reserved or addr.is_unspecified or not addr.is_global):
        raise FetchError("That address is not reachable from here")


def _resolve(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"Could not resolve {host}") from exc
    ips = [info[4][0] for info in infos]
    if not ips:
        raise FetchError(f"Could not resolve {host}")
    for ip in ips:  # every answer must be public, not just the first
        _check_ip(ip)
    return ips[0]


class _GuardedBackend(httpcore.SyncBackend):
    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return super().connect_tcp(_resolve(host, port), port, timeout, local_address, socket_options)


def _check_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise FetchError("Only http and https links can be fetched")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if port not in (80, 443) and port < 1024:
        raise FetchError("That port is not allowed")


@dataclass
class Head:
    url: str                 # after redirects
    status: int
    content_type: str | None
    size: int | None
    filename: str | None


def _filename(url: str, disposition: str | None) -> str | None:
    if disposition:
        m = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", disposition, re.IGNORECASE) or re.search(
            r'filename="?([^";]+)"?', disposition, re.IGNORECASE
        )
        if m:
            return unquote(m.group(1).strip())
    tail = unquote(urlparse(url).path.rsplit("/", 1)[-1])
    return tail or None


def _header(resp, name: str) -> str | None:
    for k, v in resp.headers:
        if k.decode("latin-1").lower() == name:
            return v.decode("latin-1")
    return None


def _open(pool: httpcore.ConnectionPool, method: str, url: str):
    """Issue a request, following redirects through the guard. Returns (url, response
    context manager) with the stream still open."""
    for _ in range(MAX_REDIRECTS + 1):
        _check_url(url)
        headers = [(b"User-Agent", USER_AGENT.encode()), (b"Accept", b"*/*")]
        timeout = settings.fetch_timeout_seconds
        cm = pool.stream(method, url, headers=headers,
                         extensions={"timeout": {"connect": timeout, "read": timeout, "write": timeout, "pool": timeout}})
        resp = cm.__enter__()
        if resp.status in (301, 302, 303, 307, 308):
            location = _header(resp, "location")
            cm.__exit__(None, None, None)
            if not location:
                raise FetchError("Redirect without a location")
            url = urljoin(url, location)
            continue
        return url, cm, resp
    raise FetchError("Too many redirects")


def _pool() -> httpcore.ConnectionPool:
    return httpcore.ConnectionPool(network_backend=_GuardedBackend(), retries=0)


def head(url: str) -> Head:
    """What a URL points at, without downloading it (GET, closed after the headers:
    plenty of servers answer HEAD wrongly or not at all)."""
    try:
        with _pool() as pool:
            final, cm, resp = _open(pool, "GET", url)
            try:
                ctype = (_header(resp, "content-type") or "").split(";")[0].strip().lower() or None
                length = _header(resp, "content-length")
                return Head(
                    url=final,
                    status=resp.status,
                    content_type=ctype,
                    size=int(length) if length and length.isdigit() else None,
                    filename=_filename(final, _header(resp, "content-disposition")),
                )
            finally:
                cm.__exit__(None, None, None)
    except FetchError:
        raise
    except Exception as exc:  # network errors of every flavour
        raise FetchError(f"Could not reach that address ({type(exc).__name__})") from exc


def download(url: str, max_bytes: int):
    """Stream a URL. Returns (final_url, content_type, filename, chunk iterator);
    the iterator closes the connection when exhausted."""
    pool = _pool()
    try:
        final, cm, resp = _open(pool, "GET", url)
    except FetchError:
        pool.close()
        raise
    except Exception as exc:
        pool.close()
        raise FetchError(f"Could not reach that address ({type(exc).__name__})") from exc
    if resp.status >= 400:
        cm.__exit__(None, None, None)
        pool.close()
        raise FetchError(f"The server answered {resp.status}")
    length = _header(resp, "content-length")
    if length and length.isdigit() and int(length) > max_bytes:
        cm.__exit__(None, None, None)
        pool.close()
        raise FetchError(f"File is larger than {max_bytes // (1024 * 1024)} MB")
    ctype = (_header(resp, "content-type") or "").split(";")[0].strip().lower() or None
    name = _filename(final, _header(resp, "content-disposition"))

    def chunks():
        try:
            yield from resp.iter_stream()
        finally:
            cm.__exit__(None, None, None)
            pool.close()

    return final, ctype, name, chunks()


def kind_of(content_type: str | None, url: str = "") -> str:
    ct = (content_type or "").lower()
    if ct.startswith("image/"):
        return "image"
    if ct == "application/pdf":
        return "pdf"
    if ct.startswith("video/"):
        return "video"
    if ct.startswith("audio/"):
        return "audio"
    if ct in ("text/html", "application/xhtml+xml"):
        return "html"
    if ct:
        return "file"
    path = urlparse(url).path.lower()
    if re.search(r"\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)$", path):
        return "image"
    if path.endswith(".pdf"):
        return "pdf"
    return "unknown"
