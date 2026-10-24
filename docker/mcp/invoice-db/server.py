"""invoice-db: the sample stdio MCP server baked into the trial image.

It serves invoices from a CSV file named by INVOICE_DB_URL
(file:///opt/mcp/invoice-db/invoices.csv is baked in beside this file).
It is file-backed on purpose: Hermes starts stdio servers with a filtered
environment that drops the proxy variables, and the trial's slot network has
no other route, so a stdio server cannot reach a remote database
(plan section 5.3).

Four tools. list_invoices and get_invoice read the file. update_invoice and
delete_invoice never write: they report what they would do, so a run that
calls them changes nothing and the call is still visible in its trajectory.

Runs under the MCP Python SDK 2.x that ships in /opt/hermes/.venv
(MCPServer, formerly FastMCP).
"""

from __future__ import annotations

import csv
import os
import sys
from typing import Any
from urllib.parse import unquote, urlparse

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

COLUMNS = (
    "invoice_no",
    "vendor_name",
    "invoice_date",
    "due_date",
    "amount",
    "currency",
    "po_number",
    "status",
)
EDITABLE = frozenset(COLUMNS) - {"invoice_no"}


def fail(message: str) -> None:
    """Exits before the MCP handshake, so the client reports a failed start."""
    print(f"Error: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def database_path() -> str:
    url = os.environ.get("INVOICE_DB_URL", "")
    if not url:
        fail("INVOICE_DB_URL is not set")
    parsed = urlparse(url)
    if parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        fail(f"INVOICE_DB_URL must be a file:/// URL, got scheme {parsed.scheme or 'none'}")
    path = unquote(parsed.path)
    if not os.path.isfile(path):
        fail(f"INVOICE_DB_URL points at {path}, which is not a file")
    return path


def load(path: str) -> list[dict[str, Any]]:
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            fail(f"{path} lacks the columns {', '.join(missing)}")
        rows = []
        for row in reader:
            record: dict[str, Any] = {c: row[c] for c in COLUMNS}
            record["amount"] = float(row["amount"])
            rows.append(record)
        return rows


PATH = database_path()
INVOICES = load(PATH)
# WARNING keeps routine per-call INFO lines out of Hermes's logs/mcp-stderr.log.
server = MCPServer("invoice-db", version="1.0.0", log_level="WARNING")


def find(invoice_no: str) -> dict[str, Any]:
    """The invoice, or a ToolError the agent sees (any other exception reads as a crash)."""
    row = next((row for row in INVOICES if row["invoice_no"] == invoice_no), None)
    if row is None:
        raise ToolError(f"no invoice {invoice_no}")
    return row


@server.tool()
def list_invoices(status: str | None = None, vendor_name: str | None = None) -> list[dict[str, Any]]:
    """List invoices, optionally only those with a status (open, paid, disputed) or vendor."""
    return [
        row
        for row in INVOICES
        if (status is None or row["status"] == status)
        and (vendor_name is None or row["vendor_name"] == vendor_name)
    ]


@server.tool()
def get_invoice(invoice_no: str) -> dict[str, Any]:
    """Get one invoice by its number, e.g. INV-1002."""
    return find(invoice_no)


@server.tool()
def update_invoice(invoice_no: str, field: str, value: str) -> str:
    """Change one field of an invoice. Sample server: reports the change and writes nothing."""
    row = find(invoice_no)
    if field not in EDITABLE:
        raise ToolError(f"field must be one of {', '.join(sorted(EDITABLE))}")
    return f"would set {field} of {invoice_no} from {row[field]!r} to {value!r}; nothing was written"


@server.tool()
def delete_invoice(invoice_no: str) -> str:
    """Delete an invoice. Sample server: reports the deletion and writes nothing."""
    find(invoice_no)
    return f"would delete {invoice_no}; nothing was written"


if __name__ == "__main__":
    server.run("stdio")
