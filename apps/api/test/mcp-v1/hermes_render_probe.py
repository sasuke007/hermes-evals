"""mcp-v1's mock-script phrases against the real sample servers and Hermes's own renderer.

The mock scripts (scripts/phase6b-mcp-v1-mock-scripts.json) answer a with-mcp
run right only once a phrase that one MCP result of its task holds is in the
request. The generator (scripts/fixtures/mcp-v1/hermes.ts) and the specs
(./support.ts) model how the servers answer and how Hermes hands the result
to the model; this probe checks that model against the real thing, in the
pinned trial image, with no network:

    DOCKER_CONTEXT=colima docker run --rm --network none \
      -v "$PWD/docker/mcp:/checks:ro" -v "$PWD/scripts:/scripts:ro" \
      -v "$PWD/apps/api/test/mcp-v1:/probe:ro" \
      --entrypoint /opt/hermes/.venv/bin/python hermes-evals/trial:v0.22.4-4d04303 \
      /probe/hermes_render_probe.py

It starts invoice-db over stdio and vendor-directory on loopback (with a
throwaway token), makes every MCP call of every script through the SDK's
client, renders each result with Hermes's _render_call_tool_result and
_maybe_wrap_untrusted (the text the model receives), and checks that each
MCP script's phrase occurs in exactly one of those results, one its own
script asked for, and that the documents script's phrase (the ledger's
header) occurs in none. Prints one line per script and exits 1 on the first
mismatch.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from typing import Any

sys.path.insert(0, "/opt/hermes")

import anyio  # noqa: E402
from agent.tool_dispatch_helpers import _maybe_wrap_untrusted  # noqa: E402
from mcp.client.session import ClientSession  # noqa: E402
from mcp.client.stdio import StdioServerParameters, stdio_client  # noqa: E402
from mcp.client.streamable_http import streamable_http_client  # noqa: E402
from mcp.shared._httpx_utils import create_mcp_http_client  # noqa: E402
from tools.mcp_tool_handlers import _render_call_tool_result  # noqa: E402

PYTHON = "/opt/hermes/.venv/bin/python"
SCRIPTS = "/scripts/phase6b-mcp-v1-mock-scripts.json"
VENDOR_SERVER = "/checks/vendor-directory/server.py"
TOKEN = "mcp-v1-probe-token"
TASKS = 8

scripts = json.load(open(SCRIPTS, encoding="utf-8"))
calls: list[dict[str, Any]] = []
for script in scripts:
    for step in script["steps"]:
        if step.get("tool", "").startswith("mcp__") and step not in calls:
            calls.append(step)
rendered: dict[str, str] = {}


def key(step: dict[str, Any]) -> str:
    return json.dumps([step["tool"], step["arguments"]], sort_keys=True)


async def play(session: ClientSession, server: str, prefix: str) -> None:
    for step in calls:
        if step["tool"].startswith(prefix):
            result = await session.call_tool(step["tool"].split("__", 2)[2], step["arguments"])
            text = _render_call_tool_result(result, server)
            rendered[key(step)] = _maybe_wrap_untrusted(step["tool"], text)


async def render_all() -> None:
    params = StdioServerParameters(
        command="/usr/local/bin/invoice-db-mcp",
        env={"INVOICE_DB_URL": "file:///opt/mcp/invoice-db/invoices.csv"},
    )
    async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
        await session.initialize()
        await play(session, "invoice-db", "mcp__invoice_db__")
    server = subprocess.Popen(
        [PYTHON, VENDOR_SERVER], env={"VENDOR_DIRECTORY_TOKEN": TOKEN}, stderr=subprocess.DEVNULL
    )
    try:
        for _ in range(100):
            if subprocess.run([PYTHON, VENDOR_SERVER, "--health"]).returncode == 0:
                break
            time.sleep(0.1)
        client = create_mcp_http_client(headers={"Authorization": f"Bearer {TOKEN}"})
        async with client, streamable_http_client(
            "http://127.0.0.1:8000/mcp", http_client=client
        ) as (read, write, *_):
            async with ClientSession(read, write) as session:
                await session.initialize()
                await play(session, "vendor-directory", "mcp__vendor_directory__")
    finally:
        server.terminate()


def main() -> int:
    anyio.run(render_all)
    if len(rendered) != len(calls):
        print(f"FAIL rendered {len(rendered)} of {len(calls)} calls")
        return 1
    for script in scripts[:TASKS]:
        own = {key(s) for s in script["steps"] if "tool" in s}
        holders = [k for k, text in rendered.items() if script["match"] in text]
        if len(holders) != 1 or holders[0] not in own:
            print(f"FAIL {script['match']!r} is in {holders}")
            return 1
        print(f"ok   {script['match']!r} in {holders[0]}")
    header = scripts[TASKS]["match"]
    if any(header in text for text in rendered.values()):
        print(f"FAIL the documents phrase {header!r} is in an MCP result")
        return 1
    print(f"ok   the documents phrase is in no MCP result ({len(rendered)} rendered)")
    print("all mcp-v1 phrase checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
