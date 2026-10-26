"""vendor-directory: the sample http MCP server (plan 18.2 P4).

A read-only directory of the vendors the sample invoice-db ledger names:
name, vendor_id, payment_terms_days, status (active or on_hold),
bank_country and notes. Its data, vendors.json beside this file, is baked
into its image and written by scripts/fixtures/sample-mcp.ts with a fixed
seed; edit the generator, not the file. Phase 6b's mcp-v1 joins it with the
ledger, and one vendor's notes hold an instruction aimed at an assistant
(the injected_note task): the server only serves it.

Two tools. list_vendors returns at most PAGE_SIZE vendors a call, by name, as
{"vendors": [...], "next_cursor": "..." | null}: pass next_cursor back with
the same filter for the next page, until it is null. get_vendor returns one
vendor by its exact name.

How it runs: Compose service `vendor-directory` in the `samples` profile
(`docker compose --profile samples up -d`), streamable HTTP at
http://vendor-directory:8000/mcp, on a network only egress shares, so a
trial reaches it through egress's MCP gateway and nothing else. Every
request must carry `Authorization: Bearer <VENDOR_DIRECTORY_TOKEN>`, the
token from this process's environment; anything else gets 401 before the MCP
layer sees it. The token is set in .env (any random string works for the
sample), and Compose gives egress the same value. The http definition maps
`Authorization` to VENDOR_DIRECTORY_TOKEN with the prefix `Bearer ` (Phase
7), so egress writes `Bearer <token>` on the way here and the value never
enters a trial (plan 5.3). Without a token the server refuses to start.

Stateless, with JSON responses: each POST stands alone, so no session is
left open between trials, and the server has nothing to push, so a GET (the
event stream) answers 405 at once rather than hanging open. Host-header
(DNS rebinding) checks are off: the server is never published to the host,
and the bearer token is the gate. `server.py --health` asks the local
server and exits 0 when it answers 401 to a request without the token.

Runs under the MCP Python SDK 2.x in /opt/hermes/.venv: the image is built
FROM the trial image and adds no dependency.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

HOST = "0.0.0.0"
PORT = 8000
PATH = "/mcp"
PAGE_SIZE = 10
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendors.json")
FIELDS = ("name", "vendor_id", "payment_terms_days", "status", "bank_country", "notes")
STATUSES = ("active", "on_hold")


def fail(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def load(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as handle:
        vendors = json.load(handle)
    if not isinstance(vendors, list):
        fail(f"{path} must hold a JSON array of vendors")
    for i, vendor in enumerate(vendors):
        if not isinstance(vendor, dict) or sorted(vendor) != sorted(FIELDS):
            fail(f"{path}: vendor {i} must have exactly the fields {', '.join(FIELDS)}")
        if vendor["status"] not in STATUSES or not isinstance(vendor["payment_terms_days"], int):
            fail(f"{path}: vendor {vendor['name']!r} has a bad status or payment_terms_days")
    return sorted(vendors, key=lambda v: v["name"])


VENDORS = load(DATA)
# WARNING keeps routine per-call INFO lines (and uvicorn's access log) out of the container log.
server = MCPServer("vendor-directory", version="1.0.0", log_level="WARNING")


def encode_cursor(offset: int, filters: list[str | None]) -> str:
    raw = json.dumps([offset, *filters], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, filters: list[str | None]) -> int:
    """The offset a cursor of this listing points at; a ToolError for any other cursor."""
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        offset, *given = json.loads(raw)
    except (binascii.Error, ValueError, TypeError):
        given, offset = None, None
    if given != filters or not isinstance(offset, int) or offset < 0:
        raise ToolError(
            "that cursor is not from this listing; list again without a cursor, with the same filter"
        )
    return offset


@server.tool()
def list_vendors(status: str | None = None, cursor: str | None = None) -> dict[str, Any]:
    """List vendors, 10 a page by name, optionally only those with a status (active, on_hold).
    Returns {"vendors": [...], "next_cursor"}: while next_cursor is not null, call again with
    it and the same status for the next page."""
    if status is not None and status not in STATUSES:
        raise ToolError(f"status must be one of {', '.join(STATUSES)}")
    rows = [v for v in VENDORS if status is None or v["status"] == status]
    offset = 0 if cursor is None else decode_cursor(cursor, [status])
    end = offset + PAGE_SIZE
    after = encode_cursor(end, [status]) if end < len(rows) else None
    return {"vendors": rows[offset:end], "next_cursor": after}


@server.tool()
def get_vendor(name: str) -> dict[str, Any]:
    """Get one vendor by its exact name, e.g. Acme Supplies."""
    vendor = next((v for v in VENDORS if v["name"] == name), None)
    if vendor is None:
        raise ToolError(f"no vendor {name}")
    return vendor


class RequireBearer:
    """401 for any HTTP request whose one Authorization header is not exactly `Bearer <token>`.

    An authorised GET gets 405: the server pushes nothing, and the transport
    lets a server refuse the GET stream that way. Otherwise the SDK holds the
    GET open, and Hermes's preflight probe waits out its 5 s timeout on it
    before every trial's first call.
    """

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.expected = f"Bearer {token}".encode("latin-1")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            given = [value for name, value in scope["headers"] if name == b"authorization"]
            if len(given) != 1 or not hmac.compare_digest(given[0], self.expected):
                response = JSONResponse(
                    {"error": "unauthorized: send Authorization: Bearer <VENDOR_DIRECTORY_TOKEN>"},
                    status_code=401,
                    headers={"WWW-Authenticate": 'Bearer realm="vendor-directory"'},
                )
                await response(scope, receive, send)
                return
            if scope["method"] == "GET":
                response = JSONResponse(
                    {"error": "this server offers no GET stream; POST JSON-RPC requests"},
                    status_code=405,
                    headers={"Allow": "POST, DELETE"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def health() -> int:
    """0 when the local server answers a request without the token with 401."""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}{PATH}", timeout=3)
    except urllib.error.HTTPError as err:
        return 0 if err.code == 401 else 1
    except OSError:
        return 1
    return 1


def main() -> None:
    token = os.environ.get("VENDOR_DIRECTORY_TOKEN", "")
    if not token:
        fail(
            "VENDOR_DIRECTORY_TOKEN is not set; any random string works for the sample"
            " (see .env.example)"
        )
    try:
        token.encode("latin-1")
    except UnicodeEncodeError:
        fail("VENDOR_DIRECTORY_TOKEN must be plain ASCII, as a header value")
    app = server.streamable_http_app(
        streamable_http_path=PATH,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        host=HOST,
    )
    uvicorn.run(RequireBearer(app, token), host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        sys.exit(health())
    main()
