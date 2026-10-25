#!/usr/bin/env bash
# Phase 1 smoke test: drives a running Hermes Evals stack over HTTP and prints
# one PASS/FAIL line per step. It covers what Phase 1 serves: suites (list,
# reload, detail, task, fixtures, history, and the versioning of a temporary
# suite directory), skills, documents, MCP servers and their "Test start",
# secrets, configurations (create, duplicate, diff, form options) and the
# system endpoints (summary, workers, sandbox).
#
#   scripts/phase1-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase1-smoke.sh  # through nginx
#   EXPECT_INVOICE_DB_URL=set scripts/phase1-smoke.sh           # insist on a passing MCP test
#
# Needs bash (3.2 is enough), curl and python3. JSON is read with python3,
# which also builds the skill zip, so jq is not needed. Exits 0 only when no
# step failed.
#
# It writes to the stack it tests, so point it at a development stack only.
# Every name it creates starts with smoke-<UTC timestamp>, so it can run again
# and again; nothing it creates is deleted (Phase 1 has no delete endpoints).
# The temporary suite directory suites/zz-smoke-<timestamp> is removed at the
# end and reloaded, which leaves its suite_sources row in state `missing` (and
# its two versions in the database), as for any suite directory deleted from
# disk: GET /suites keeps listing it, last load "Missing from disk".
#
# Settings (environment):
#   BASE_URL               API base URL (default http://localhost:3000/api)
#   SUITES_DIR             host directory the worker reads suites from (default <repo>/suites)
#   SOURCE_SUITE           suite to read and copy (default invoices-v1)
#   SOURCE_TASK            task of SOURCE_SUITE to read and edit (default total_due)
#   EXPECT_INVOICE_DB_URL  set | unset | auto (default): whether the worker must have INVOICE_DB_URL
#   SMOKE_MODEL            model of the configurations it creates (default openai/gpt-6.1-sol)
#   SMOKE_DOCKER           auto (default) | 0: compare the form's toolsets with the workers row,
#                          read-only through `docker compose exec postgres psql`
#   CURL_TIMEOUT           seconds per request (default 300; a reload or MCP test waits for the worker)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SOURCE_SUITE="${SOURCE_SUITE:-invoices-v1}"
SOURCE_TASK="${SOURCE_TASK:-total_due}"
EXPECT_INVOICE_DB_URL="${EXPECT_INVOICE_DB_URL:-auto}"
SMOKE_MODEL="${SMOKE_MODEL:-openai/gpt-6.1-sol}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
CURL_TIMEOUT="${CURL_TIMEOUT:-300}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
TEMP_SUITE="zz-smoke-$STAMP"
TEMP_DIR="$SUITES_DIR/$TEMP_SUITE"
export SOURCE_SUITE SOURCE_TASK PREFIX TEMP_SUITE

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "phase1-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase1-smoke.XXXXXX")"
BODY="$WORK/body"
HEADERS="$WORK/headers"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# request METHOD PATH [curl args...]: the body lands in $BODY, the headers in
# $HEADERS and the status in $STATUS (000 when curl itself failed, with its
# error as the body). State-changing requests carry X-Requested-With, which
# the API requires of every POST, PUT, PATCH and DELETE.
request() {
  local method="$1" path="$2"
  shift 2
  : >"$HEADERS"
  if [ "$method" = GET ]; then
    STATUS="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
  else
    STATUS="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      -X "$method" -H 'X-Requested-With: phase1-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
  fi
  if [ "$STATUS" = 000 ]; then cp "$WORK/curl.err" "$BODY"; fi
  return 0
}

# send_json METHOD PATH [JSON]: a JSON request; the body defaults to {}.
send_json() {
  local json='{}'
  [ $# -ge 3 ] && json="$3"
  request "$1" "$2" -H 'Content-Type: application/json' --data-binary "$json"
}

# upload PATH FILE TYPE: a multipart upload in the field `file`.
upload() {
  request POST "$1" -F "file=@$2;type=$3"
}

# jv EXPR [FILE]: evaluates a Python expression over the JSON in FILE (default
# the last response) as `d`, with `env` (the environment), `json` and `raw`
# (the file's text). A string prints as it is, anything else as JSON.
# Expressions use str.format, not f-strings: Python before 3.12 refuses a
# backslash inside an f-string, and the shell quoting would need one.
jv() {
  python3 - "$1" "${2:-$BODY}" <<'PY'
import json, os, sys
expr, path = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8', errors='replace') as f:
    raw = f.read()
try:
    d = json.loads(raw)
except ValueError:
    d = None
try:
    value = eval(expr, {'d': d, 'env': os.environ, 'json': json, 'raw': raw})
except Exception as exc:
    print('{}: {}'.format(type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
print(value if isinstance(value, str) else json.dumps(value))
PY
}

line() { printf '%-5s %-58s %s\n' "$1" "$2" "$3"; }
pass() { PASSES=$((PASSES + 1)); line PASS "$1" "${2:-}"; }
fail() { FAILS=$((FAILS + 1)); line FAIL "$1" "${2:-}"; }
skip() { SKIPS=$((SKIPS + 1)); line SKIP "$1" "${2:-}"; }
snippet() { tr '\n' ' ' <"$BODY" | cut -c1-300; }

# check NAME STATUS EXPR [DETAIL]: PASS when the last response has STATUS and
# EXPR is true over its body, printing DETAIL (an expression) after it.
check() {
  local name="$1" want="$2" expr="$3" detail="${4:-}" result shown=''
  if [ "$STATUS" != "$want" ]; then
    fail "$name" "HTTP $STATUS, want $want: $(snippet)"
    return 1
  fi
  result="$(jv "$expr" 2>"$WORK/jv.err")"
  if [ "$result" != true ]; then
    fail "$name" "check is $result $(tr '\n' ' ' <"$WORK/jv.err" | cut -c1-160)· body: $(snippet)"
    return 1
  fi
  if [ -n "$detail" ]; then
    shown="$(jv "$detail" 2>"$WORK/jv.err")" || shown="(detail: $(tr '\n' ' ' <"$WORK/jv.err" | cut -c1-160))"
  fi
  pass "$name" "$shown"
}

# need NAME VALUE...: SKIP NAME (and return 1) when a value an earlier step should have produced is empty.
need() {
  local name="$1" value
  shift
  for value in "$@"; do
    if [ -z "$value" ]; then
      skip "$name" "an earlier step failed"
      return 1
    fi
  done
  return 0
}

sha256_of() { python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }
urlencode() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
section() { printf '\n== %s\n' "$1"; }

# Removes the temporary suite directory when a step left it behind (and
# reloads it, so it is `missing` rather than current), then the work directory.
cleanup() {
  if [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
    send_json POST /suites/reload "{\"path\":\"$TEMP_SUITE\"}"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'Phase 1 smoke · %s · stamp %s · INVOICE_DB_URL expected: %s\n' "$BASE_URL" "$STAMP" "$EXPECT_INVOICE_DB_URL"

# ---------------------------------------------------------------------------
section 'Health and request guard'
# ---------------------------------------------------------------------------

request GET /health
check 'GET /health' 200 \
  'd["status"] == "ok" and all(v == "ok" for v in d["checks"].values())' \
  '"status " + d["status"] + " · " + ", ".join(k + " " + v for k, v in d["checks"].items())'

STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 30 -X POST -H 'Content-Type: application/json' \
  --data-binary '{}' "$BASE_URL/suites/reload" 2>/dev/null)" || STATUS=000
check 'POST without X-Requested-With is refused' 403 \
  '"X-Requested-With" in d["message"]' 'str(d["statusCode"]) + " " + d["message"]'

# ---------------------------------------------------------------------------
section "Suites ($SOURCE_SUITE)"
# ---------------------------------------------------------------------------

request GET /suites
check "GET /suites lists $SOURCE_SUITE" 200 \
  'any(s["name"] == env["SOURCE_SUITE"] and s["versionNumber"] >= 1 for s in d)' \
  '"; ".join("{name} v{versionNumber} · {validCount}/{taskCount} valid · last load {lastLoad[outcome]}".format_map(s) for s in d)'
SUITE_ID="$(jv 'next(s["suiteId"] for s in d if s["name"] == env["SOURCE_SUITE"])' 2>/dev/null)"

send_json POST /suites/reload
check 'POST /suites/reload (every directory)' 200 \
  'any(e["sourcePath"] == "./suites/" + env["SOURCE_SUITE"] and e["outcome"] in ("unchanged", "created", "reverted") for e in d["suites"])' \
  '"; ".join("{sourcePath} {outcome} v{versionNumber}: {message}".format_map(e) for e in d["suites"])'
RELOADED_ID="$(jv 'next(e["suiteId"] for e in d["suites"] if e["sourcePath"] == "./suites/" + env["SOURCE_SUITE"])' 2>/dev/null)"
[ -n "$RELOADED_ID" ] && SUITE_ID="$RELOADED_ID"
export SUITE_ID

if need 'suite detail, task, fixtures and history' "$SUITE_ID"; then
  request GET "/suites/$SUITE_ID"
  check "GET /suites/:id ($SOURCE_TASK valid)" 200 \
    'd["current"] and any(t["key"] == env["SOURCE_TASK"] and t["valid"] for t in d["tasks"]) and d["validCount"] == d["taskCount"]' \
    '"v{versionNumber} ({versionLabel}) #{contentHash:.7} · ".format_map(d) + ", ".join("{} v{} {}".format(t["key"], t["version"], "valid" if t["valid"] else "INVALID") for t in d["tasks"])'

  request GET "/suites/$SUITE_ID/tasks/$SOURCE_TASK"
  check "GET task $SOURCE_TASK" 200 \
    'd["valid"] and d["selfCheck"]["status"] == "passed" and len(d["fixtures"]) >= 1' \
    '"v{} · self-check {} · fixtures ".format(d["version"], d["selfCheck"]["status"]) + ", ".join("{path} ({typeLabel})".format_map(f) for f in d["fixtures"])'
  FIXTURE_PATH="$(jv 'd["fixtures"][0]["path"]' 2>/dev/null)"
  FIXTURE_SHA="$(jv 'd["fixtures"][0]["sha256"]' 2>/dev/null)"

  if need 'fixture preview and download' "$FIXTURE_PATH"; then
    FIXTURE_SEGMENT="$(urlencode "$FIXTURE_PATH")"
    request GET "/suites/$SUITE_ID/tasks/$SOURCE_TASK/fixtures/$FIXTURE_SEGMENT/preview"
    check "GET fixture preview ($FIXTURE_PATH)" 200 \
      'd is not None and len(d["columns"]) > 0 and len(d["rows"]) > 0' \
      '"{} columns ({}, ...) · {} of {} rows".format(len(d["columns"]), ", ".join(d["columns"][:4]), len(d["rows"]), d["totalRows"])'

    request GET "/suites/$SUITE_ID/tasks/$SOURCE_TASK/fixtures/$FIXTURE_SEGMENT"
    GOT_SHA="$(sha256_of "$BODY")"
    if [ "$STATUS" = 200 ] && [ "$GOT_SHA" = "$FIXTURE_SHA" ] && grep -qi '^content-disposition: attachment' "$HEADERS"; then
      pass "GET fixture download ($FIXTURE_PATH)" "$(wc -c <"$BODY" | tr -d ' ') bytes · sha256 ${GOT_SHA:0:7} matches the task view · attachment"
    else
      fail "GET fixture download ($FIXTURE_PATH)" "HTTP $STATUS, sha256 ${GOT_SHA:0:7} vs ${FIXTURE_SHA:0:7}"
    fi
  fi

  request GET "/suites/$SUITE_ID/history"
  check 'GET /suites/:id/history' 200 \
    'len(d) >= 1 and sum(1 for e in d if e["current"]) == 1' \
    '"; ".join("v{} {}{}".format(e["versionNumber"], e["outcome"], " (current)" if e["current"] else "") for e in d)'

  request GET "/suites/$SUITE_ID/tasks/$SOURCE_TASK/history"
  check "GET task $SOURCE_TASK history" 200 \
    'len(d) >= 1 and any(v["current"] for v in d)' \
    '"; ".join("task v{version} since suite v{introducedInSuiteVersion}".format_map(v) for v in d)'
fi

# ---------------------------------------------------------------------------
section "Suite versioning (temporary directory suites/$TEMP_SUITE)"
# ---------------------------------------------------------------------------

TEMP_PROMPT="$TEMP_DIR/$SOURCE_TASK/prompt.md"
if [ -d "$SUITES_DIR/$SOURCE_SUITE" ] && cp -R "$SUITES_DIR/$SOURCE_SUITE" "$TEMP_DIR"; then
  # A copy keeps its source's suite.yaml name, which a live directory holds; rename it.
  python3 - "$TEMP_DIR/suite.yaml" "$TEMP_SUITE" <<'PY'
import re, sys
path, name = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as f:
    text = f.read()
with open(path, 'w', encoding='utf-8') as f:
    f.write(re.sub(r'^name:.*$', 'name: ' + name, text, count=1, flags=re.M))
PY
  cp "$TEMP_PROMPT" "$WORK/prompt.md.orig"
  RELOAD_ONE="{\"path\":\"./suites/$TEMP_SUITE\"}"

  send_json POST /suites/reload "$RELOAD_ONE"
  check 'reload the new directory -> created v1' 200 \
    'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1 and d["suites"][0]["sourcePath"] == "./suites/" + env["TEMP_SUITE"]' \
    '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
  V1_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"
  export V1_ID

  printf '\nSmoke edit %s: state the total in US dollars.\n' "$STAMP" >>"$TEMP_PROMPT"
  send_json POST /suites/reload "$RELOAD_ONE"
  check "reload after editing $SOURCE_TASK/prompt.md -> created v2" 200 \
    'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 2 and d["suites"][0]["changes"]["changed"] == [env["SOURCE_TASK"]]' \
    '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
  V2_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"

  if need "GET task diff v1 -> v2" "$V1_ID" "$V2_ID"; then
    request GET "/suites/$V2_ID/tasks/$SOURCE_TASK/diff?against=$V1_ID"
    check 'GET task diff v1 -> v2' 200 \
      'd["from"]["suiteVersion"] == 1 and d["to"]["suiteVersion"] == 2 and any(l["kind"] == "added" and "Smoke edit" in l["text"] for l in d["prompt"]) and not any(l["kind"] == "removed" for l in d["prompt"]) and all(l["kind"] == "same" for l in d["taskYaml"]) and d["reference"] == [] and all(f["change"] == "unchanged" for f in d["files"])' \
      '"task v{} -> v{} · prompt +{}/-{} lines · task.yaml and reference unchanged · files: {}".format(d["from"]["taskVersion"], d["to"]["taskVersion"], sum(l["kind"] == "added" for l in d["prompt"]), sum(l["kind"] == "removed" for l in d["prompt"]), ", ".join("{path} {change}".format_map(f) for f in d["files"]))'

    request GET "/suites/$V2_ID/tasks/$SOURCE_TASK/history"
    check "GET task $SOURCE_TASK history (v2)" 200 \
      'len(d) == 2 and d[0]["current"] and d[0]["version"] == 2' \
      '"; ".join("task v{} since suite v{}{}: {}".format(v["version"], v["introducedInSuiteVersion"], " (current)" if v["current"] else "", ", ".join(v["changedFiles"]) or "-") for v in d)'
  fi

  cp "$WORK/prompt.md.orig" "$TEMP_PROMPT"
  send_json POST /suites/reload "$RELOAD_ONE"
  check 'reload after reverting the edit -> reverted to v1' 200 \
    'd["suites"][0]["outcome"] == "reverted" and d["suites"][0]["versionNumber"] == 1 and d["suites"][0]["suiteId"] == env.get("V1_ID")' \
    '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'

  if need 'version selector after the revert' "$V1_ID"; then
    request GET "/suites/$V1_ID"
    check 'GET /suites/:v1 is current again, marked reverted' 200 \
      'd["current"] and len(d["versions"]) == 2 and d["versions"][0]["versionNumber"] == 1 and d["versions"][0]["current"] and d["versions"][0]["reverted"]' \
      '"versions: " + ", ".join("v{}{}{}".format(v["versionNumber"], " (reverted)" if v["reverted"] else "", " current" if v["current"] else "") for v in d["versions"])'

    request GET "/suites/$V1_ID/history"
    check 'GET /suites/:v1/history' 200 \
      'len(d) >= 2' \
      '"; ".join("v{} {}{}".format(e["versionNumber"], e["outcome"], " (current)" if e["current"] else "") for e in d)'
  fi

  rm -rf "$TEMP_DIR"
  send_json POST /suites/reload "$RELOAD_ONE"
  check 'reload after deleting the directory -> missing' 200 \
    'd["suites"][0]["outcome"] == "missing"' \
    '"{outcome}: {message} (its suite_sources row stays, in state missing)".format_map(d["suites"][0])'

  # The list keeps the directory, at its last version, with "Missing from
  # disk" as its last load (UI_FLOWS 8.1), until the directory comes back.
  request GET /suites
  check 'GET /suites shows it as missing from disk' 200 \
    'any(s["name"] == env["TEMP_SUITE"] and s["lastLoad"]["outcome"] == "missing" for s in d) and any(s["name"] == env["SOURCE_SUITE"] and s["lastLoad"]["outcome"] != "missing" for s in d)' \
    '"; ".join("{name} v{versionNumber} · last load {lastLoad[outcome]}".format_map(s) for s in d if s["name"] in (env["TEMP_SUITE"], env["SOURCE_SUITE"]))'
else
  fail 'copy the suite into a temporary directory' "cannot copy $SUITES_DIR/$SOURCE_SUITE to $TEMP_DIR"
fi

# ---------------------------------------------------------------------------
section 'Skills'
# ---------------------------------------------------------------------------

SKILL_NAME="$PREFIX-invoice-method"
SKILL_ZIP="$WORK/$SKILL_NAME.zip"
export SKILL_NAME
python3 - "$SKILL_ZIP" "$SKILL_NAME" "$WORK" <<'PY'
import sys, zipfile
path, name, work = sys.argv[1], sys.argv[2], sys.argv[3]
skill_md = """---
name: {}
version: 1.0.0
description: Smoke-test skill. Reconcile invoices before totalling them.
---

# Invoice method

1. Drop duplicate invoice numbers.
2. Sum the amounts of invoices whose status is not `paid`.
""".format(name)
reconcile = "def total_due(rows):\n    return sum(r['amount'] for r in rows if r['status'] != 'paid')\n"
with open(work + '/reconcile.py', 'w') as f:
    f.write(reconcile)
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    # One top-level folder, as "Compress" on a folder makes it; the API strips it.
    z.writestr(name + '/SKILL.md', skill_md)
    z.writestr(name + '/examples/reconcile.py', reconcile)
PY

upload /resources/skills/validate "$SKILL_ZIP" application/zip
check 'POST /resources/skills/validate (zip built here)' 200 \
  'd["outcome"] == "valid" and bool(d["token"]) and d["name"] == env["SKILL_NAME"] and d["version"] == "1.0.0"' \
  '"{outcome} · {name}@{version} · ".format_map(d) + ", ".join(f["path"] for f in d["fileTree"])'
SKILL_TOKEN="$(jv 'd["token"]' 2>/dev/null)"

SKILL_ID=''
if need 'POST /resources/skills (confirm)' "$SKILL_TOKEN"; then
  send_json POST /resources/skills "{\"token\":\"$SKILL_TOKEN\"}"
  check 'POST /resources/skills (confirm)' 201 \
    'd["name"] == env["SKILL_NAME"] and d["fileCount"] == 2' \
    '"{name}@{version} #{contentHash:.7} · {fileCount} files · {unpackedBytes} bytes".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
fi
export SKILL_ID

if need 'skill detail, file and zip' "$SKILL_ID"; then
  request GET "/resources/skills/$SKILL_ID"
  check 'GET /resources/skills/:id' 200 \
    'sorted(f["path"] for f in d["files"]) == ["SKILL.md", "examples/reconcile.py"] and "Invoice method" in d["skillMd"]["body"]' \
    '", ".join("{path} ({kind})".format_map(f) for f in d["files"])'

  request GET "/resources/skills/$SKILL_ID/files/$(urlencode examples/reconcile.py)"
  RECONCILE="$(cat "$WORK/reconcile.py")"
  export RECONCILE
  check 'GET skill file examples/reconcile.py' 200 \
    'd["content"].strip() == env["RECONCILE"].strip()' \
    '"{kind} · {sizeBytes} bytes · content matches".format_map(d)'

  request GET "/resources/skills/$SKILL_ID/zip"
  ZIP_NAMES="$(python3 - "$BODY" <<'PY'
import sys, zipfile
try:
    print(', '.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))
except zipfile.BadZipFile as exc:
    print('not a zip: {}'.format(exc))
PY
  )"
  if [ "$STATUS" = 200 ] && grep -qi '^content-type: application/zip' "$HEADERS" && [[ "$ZIP_NAMES" == *SKILL.md* ]]; then
    pass 'GET skill zip download' "application/zip · $ZIP_NAMES"
  else
    fail 'GET skill zip download' "HTTP $STATUS: $ZIP_NAMES"
  fi

  upload /resources/skills/validate "$SKILL_ZIP" application/zip
  check 'validate the same zip again -> conflict, no token' 200 \
    'd["outcome"] == "conflict" and d["token"] is None and d["existing"]["id"] == env["SKILL_ID"]' \
    'd["outcome"] + ": " + "; ".join(p["title"] for p in d["problems"])'
fi

# ---------------------------------------------------------------------------
section 'Documents'
# ---------------------------------------------------------------------------

DOC_FILE="$WORK/$PREFIX-vendor-notes.txt"
printf 'Vendor notes for the smoke test %s.\nNET 30 unless the contract says otherwise.\n' "$STAMP" >"$DOC_FILE"
DOC_NAME="$(basename "$DOC_FILE")"
DOC_SHA="$(sha256_of "$DOC_FILE")"
export DOC_NAME DOC_SHA

upload /resources/documents "$DOC_FILE" text/plain
check 'POST /resources/documents (upload)' 201 \
  'd["filename"] == env["DOC_NAME"] and d["sha256"] == env["DOC_SHA"]' \
  '"{filename} · {typeLabel} · {sizeBytes} bytes · #{sha256:.7}".format_map(d)'
DOC_ID="$(jv 'd["id"]' 2>/dev/null)"
export DOC_ID

if need 'document download and list' "$DOC_ID"; then
  request GET "/resources/documents/$DOC_ID/content"
  GOT_SHA="$(sha256_of "$BODY")"
  if [ "$STATUS" = 200 ] && [ "$GOT_SHA" = "$DOC_SHA" ] && grep -qi '^x-content-type-options: nosniff' "$HEADERS"; then
    pass 'GET /resources/documents/:id/content' "$(grep -i '^content-type:' "$HEADERS" | tr -d '\r' | cut -c15-) · sha256 matches · nosniff"
  else
    fail 'GET /resources/documents/:id/content' "HTTP $STATUS, sha256 ${GOT_SHA:0:7} vs ${DOC_SHA:0:7}"
  fi

  request GET /resources/documents
  check 'GET /resources/documents lists it' 200 \
    'any(x["id"] == env["DOC_ID"] for x in d)' '"{} documents".format(len(d))'
fi

# ---------------------------------------------------------------------------
section 'MCP servers and secrets'
# ---------------------------------------------------------------------------

MCP_STDIO_NAME="$PREFIX-invoice-db"
MCP_HTTP_NAME="$PREFIX-vendor-api"
export MCP_STDIO_NAME MCP_HTTP_NAME
STDIO_DEFINITION="{\"name\":\"$MCP_STDIO_NAME\",\"transport\":\"stdio\",\"command\":\"invoice-db-mcp\",\"args\":[],\"envNames\":[\"INVOICE_DB_URL\"],\"url\":null,\"headers\":[],\"include\":[],\"exclude\":[],\"timeoutS\":30}"
HTTP_DEFINITION="{\"name\":\"$MCP_HTTP_NAME\",\"transport\":\"http\",\"command\":null,\"args\":[],\"envNames\":[],\"url\":\"https://vendor-api.example.com/mcp\",\"headers\":[{\"header\":\"Authorization\",\"env\":\"VENDOR_API_TOKEN\"}],\"include\":[],\"exclude\":[],\"timeoutS\":30}"

send_json POST /resources/mcp-servers "$STDIO_DEFINITION"
check "POST mcp-servers $MCP_STDIO_NAME (stdio)" 201 \
  'd["name"] == env["MCP_STDIO_NAME"] and d["version"] == 1 and d["envNames"] == ["INVOICE_DB_URL"] and d["lastTest"]["status"] == "untested" and not d["frozen"]' \
  '"v{version} · {transport} · command {command} · env {envNames}".format_map(d)'
MCP_STDIO_ID="$(jv 'd["id"]' 2>/dev/null)"
MCP_STDIO_VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"

send_json POST /resources/mcp-servers "$HTTP_DEFINITION"
check "POST mcp-servers $MCP_HTTP_NAME (http)" 201 \
  'd["name"] == env["MCP_HTTP_NAME"] and d["headers"] == [{"header": "Authorization", "env": "VENDOR_API_TOKEN"}]' \
  '"v{version} · {transport} · {url} · ".format_map(d) + ", ".join("{header} <- {env}".format_map(h) for h in d["headers"])'
MCP_HTTP_ID="$(jv 'd["id"]' 2>/dev/null)"
export MCP_STDIO_ID MCP_STDIO_VERSION_ID MCP_HTTP_ID

request GET /resources/secrets
check 'GET /resources/secrets (names, sources, exposures)' 200 \
  'any(r["name"] == "INVOICE_DB_URL" and r["source"] == "worker" and r["exposure"] == "readable_by_agent" and any(x["name"] == env["MCP_STDIO_NAME"] and x["via"] == "env" for x in r["referencedBy"]) for r in d) and any(r["name"] == "VENDOR_API_TOKEN" and r["source"] == "egress" and r["exposure"] == "egress_only" and any(x["name"] == env["MCP_HTTP_NAME"] and x["via"] == "header" and x["header"] == "Authorization" for x in r["referencedBy"]) for r in d)' \
  '"; ".join("{} {} {} {}".format(r["name"], r["source"], r["exposure"], "set" if r["set"] else "not set") for r in d if r["name"] in ("INVOICE_DB_URL", "VENDOR_API_TOKEN"))'
INVOICE_DB_SET="$(jv 'next(r["set"] for r in d if r["name"] == "INVOICE_DB_URL" and r["source"] == "worker")' 2>/dev/null)"
check 'secrets carry names only, never a value' 200 \
  'all(set(r) == {"name", "set", "source", "exposure", "referencedBy", "lastCheckedAt", "checkedWhen"} for r in d) and "file:///" not in raw' \
  '"{} rows · fields: name, set, source, exposure, referencedBy, lastCheckedAt, checkedWhen".format(len(d))'

case "$EXPECT_INVOICE_DB_URL" in
  set)
    if [ "$INVOICE_DB_SET" = true ]; then pass 'the worker has INVOICE_DB_URL (expected: set)' 'set: true'
    else fail 'the worker has INVOICE_DB_URL (expected: set)' "set: ${INVOICE_DB_SET:-unknown}"; fi ;;
  unset)
    if [ "$INVOICE_DB_SET" = false ]; then pass 'the worker lacks INVOICE_DB_URL (expected: unset)' 'set: false'
    else fail 'the worker lacks INVOICE_DB_URL (expected: unset)' "set: ${INVOICE_DB_SET:-unknown}"; fi ;;
esac

STDIO_TEST_STATUS=''
if need "Test start $MCP_STDIO_NAME" "$MCP_STDIO_ID" "$INVOICE_DB_SET"; then
  send_json POST "/resources/mcp-servers/$MCP_STDIO_ID/test"
  if [ "$INVOICE_DB_SET" = true ]; then
    check "Test start $MCP_STDIO_NAME -> passed, 4 tools" 200 \
      'd["status"] == "passed" and sorted(t["name"] for t in d["tools"]) == ["delete_invoice", "get_invoice", "list_invoices", "update_invoice"] and all(t["included"] for t in d["tools"]) and "file:///" not in raw' \
      '"{} in {} ms · tools: {}".format(d["status"], d["startedMs"], ", ".join(t["name"] for t in d["tools"]))'
  else
    check "Test start $MCP_STDIO_NAME -> failed, INVOICE_DB_URL missing" 200 \
      'd["status"] == "failed" and d["missingSecretNames"] == ["INVOICE_DB_URL"] and "INVOICE_DB_URL" in d["error"]' \
      '"{status}: {error} · missing {missingSecretNames}".format_map(d)'
  fi
  STDIO_TEST_STATUS="$(jv 'd["status"]' 2>/dev/null)"
  export STDIO_TEST_STATUS

  send_json POST /resources/mcp-servers/test "$STDIO_DEFINITION"
  check 'Test start of the unsaved form gives the same result' 200 \
    'd["status"] == env["STDIO_TEST_STATUS"] and "file:///" not in raw' \
    'd["status"] + " · " + (", ".join(t["name"] for t in d["tools"]) if d["status"] == "passed" else d["error"])'
fi

if need "Test start $MCP_HTTP_NAME" "$MCP_HTTP_ID"; then
  send_json POST "/resources/mcp-servers/$MCP_HTTP_ID/test"
  # Through the egress MCP gateway: VENDOR_API_TOKEN is not in egress's
  # environment, or, when it is, vendor-api.example.com serves no MCP server.
  check "Test start $MCP_HTTP_NAME -> failed (no such server)" 200 \
    'd["status"] == "failed" and d["error"] and "TOKEN=" not in raw' \
    '"{status}: {error} · missing {missingSecretNames}".format_map(d)'
fi

if need 'GET /resources/mcp-servers records the last tests' "$MCP_STDIO_ID" "$MCP_HTTP_ID" "$STDIO_TEST_STATUS"; then
  request GET /resources/mcp-servers
  check 'GET /resources/mcp-servers records the last tests' 200 \
    'next(r for r in d if r["id"] == env["MCP_STDIO_ID"])["lastTest"]["status"] == env["STDIO_TEST_STATUS"] and next(r for r in d if r["id"] == env["MCP_HTTP_ID"])["lastTest"]["status"] == "failed"' \
    '"; ".join("{} v{} · last test {}".format(r["name"], r["version"], r["lastTest"]["status"]) for r in d if r["name"].startswith(env["PREFIX"]))'
fi

# ---------------------------------------------------------------------------
section 'Configurations'
# ---------------------------------------------------------------------------

request GET /configurations/form-options
check 'GET /configurations/form-options' 200 \
  'len(d["toolsets"]) > 0 and {t["name"] for t in d["toolsets"] if t["defaultOn"]} == {"file", "terminal"} and any(s["skillId"] == env["SKILL_ID"] for s in d["skills"]) and any(x["documentId"] == env["DOC_ID"] for x in d["documents"]) and any(m["versionId"] == env["MCP_STDIO_VERSION_ID"] and m["latest"] for m in d["mcpServers"])' \
  '"{} toolsets (on by default: {}) · {} models · {} providers · {} skills · {} documents · {} MCP versions".format(len(d["toolsets"]), ", ".join(t["name"] for t in d["toolsets"] if t["defaultOn"]), len(d["models"]), len(d["providers"]), len(d["skills"]), len(d["documents"]), len(d["mcpServers"]))'
cp "$BODY" "$WORK/form-options.json"

# The form's toolsets must be the list the live worker read from the trial
# image (`hermes tools list`), not the built-in fallback; the workers row
# holds that list. Read-only, through docker compose, when it is reachable.
WORKER_TOOLSETS=''
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null; then
  WORKER_TOOLSETS="$(cd "$REPO_DIR" && docker compose exec -T postgres psql -U hermes -d hermes_evals -At -c \
    "select array_to_json(toolsets) from workers where stopped_at is null order by started_at desc limit 1" 2>/dev/null)"
fi
if [ -n "$WORKER_TOOLSETS" ]; then
  export WORKER_TOOLSETS
  check "form-options toolsets = the live worker's list from the image" 200 \
    '[t["name"] for t in d["toolsets"]] == json.loads(env["WORKER_TOOLSETS"])' \
    '", ".join(t["name"] for t in d["toolsets"])' 
else
  skip "form-options toolsets = the live worker's list from the image" 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

BASELINE_NAME="$PREFIX-baseline"
WITH_MCP_NAME="$PREFIX-with-mcp"
export BASELINE_NAME WITH_MCP_NAME
send_json POST /configurations "{\"name\":\"$BASELINE_NAME\",\"model\":\"$SMOKE_MODEL\",\"provider\":\"nous\",\"baseUrl\":null,\"toolsets\":[\"file\",\"terminal\"],\"memoryEnabled\":false,\"skillIds\":[],\"documentIds\":[],\"mcpServerVersionIds\":[],\"maxTurns\":20,\"timeBudgetS\":300,\"duplicatedFromVersionId\":null}"
check "POST /configurations $BASELINE_NAME" 201 \
  'd["version"] == 1 and d["createdNewVersion"]' '"version {version} · id {configurationId}".format_map(d)'
BASELINE_ID="$(jv 'd["configurationId"]' 2>/dev/null)"
BASELINE_VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
export BASELINE_ID BASELINE_VERSION_ID

WITH_MCP_ID=''
WITH_MCP_VERSION_ID=''
if need 'configuration detail and duplicate' "$BASELINE_ID"; then
  request GET "/configurations/$BASELINE_ID"
  check 'GET /configurations/:id (baseline)' 200 \
    'd["name"] == env["BASELINE_NAME"] and d["latest"]["toolsets"] == ["file", "terminal"] and d["latest"]["frozenAt"] is None and d["duplicatedFrom"] is None' \
    '"v{version} · {model} via {provider} · toolsets {toolsets} · #{configHash:.7}".format_map(d["latest"])'

  send_json POST "/configurations/$BASELINE_ID/duplicate"
  check 'POST /configurations/:id/duplicate (draft)' 200 \
    'd["mode"] == "duplicate" and d["source"]["configurationId"] == env["BASELINE_ID"] and d["values"]["duplicatedFromVersionId"] == env["BASELINE_VERSION_ID"]' \
    '"draft from {} v{} · proposed name {!r}".format(d["source"]["name"], d["source"]["version"], d["values"]["name"])'
  DUPLICATE_DRAFT="$WORK/duplicate-draft.json"
  cp "$BODY" "$DUPLICATE_DRAFT"

  if need "POST /configurations $WITH_MCP_NAME" "$MCP_STDIO_VERSION_ID" "$SKILL_ID" "$DOC_ID"; then
    WITH_MCP_BODY="$(jv 'json.dumps(dict(d["values"], name=env["WITH_MCP_NAME"], mcpServerVersionIds=[env["MCP_STDIO_VERSION_ID"]], skillIds=[env["SKILL_ID"]], documentIds=[env["DOC_ID"]]))' "$DUPLICATE_DRAFT")"
    send_json POST /configurations "$WITH_MCP_BODY"
    check "POST /configurations $WITH_MCP_NAME (duplicate + MCP, skill, document)" 201 \
      'd["version"] == 1 and d["createdNewVersion"]' '"version {version} · id {configurationId}".format_map(d)'
    WITH_MCP_ID="$(jv 'd["configurationId"]' 2>/dev/null)"
    WITH_MCP_VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
  fi
fi
export WITH_MCP_ID WITH_MCP_VERSION_ID

if need 'configuration diff and usage' "$WITH_MCP_ID"; then
  request GET "/configurations/$WITH_MCP_ID"
  check "GET /configurations/:id ($WITH_MCP_NAME)" 200 \
    'd["duplicatedFrom"]["configurationId"] == env["BASELINE_ID"] and {"mcp_servers", "skills", "documents"} <= set(d["differsFromSource"]) and [m["name"] for m in d["latest"]["mcpServers"]] == [env["MCP_STDIO_NAME"]]' \
    '"duplicated from {} v{} · differs in {} · change: {}".format(d["duplicatedFrom"]["name"], d["duplicatedFrom"]["version"], ", ".join(d["differsFromSource"]), d["latest"]["change"])'

  request GET "/configurations/diff?versions=$BASELINE_VERSION_ID,$WITH_MCP_VERSION_ID"
  check 'GET /configurations/diff (baseline vs with-mcp)' 200 \
    'len(d["columns"]) == 2 and d["differing"] == ["skills", "documents", "mcp_servers"] and env["MCP_STDIO_NAME"] in next(r for r in d["rows"] if r["field"] == "mcp_servers")["values"][1]' \
    '"differing: " + ", ".join(d["differing"]) + " · mcp_servers: " + " | ".join(next(r for r in d["rows"] if r["field"] == "mcp_servers")["values"])'

  request GET /resources/mcp-servers
  check "$MCP_STDIO_NAME is frozen, used by $WITH_MCP_NAME" 200 \
    'any(r["id"] == env["MCP_STDIO_ID"] and r["frozen"] and [u["name"] for u in r["usedBy"]] == [env["WITH_MCP_NAME"]] for r in d)' \
    'next("frozen v{} · used by {}".format(r["version"], ", ".join(u["name"] for u in r["usedBy"])) for r in d if r["id"] == env["MCP_STDIO_ID"])'

  request GET /resources/skills
  check "skill and document used by $WITH_MCP_NAME" 200 \
    'any(s["id"] == env["SKILL_ID"] and [u["name"] for u in s["usedBy"]] == [env["WITH_MCP_NAME"]] for s in d)' \
    'next("{} used by {}".format(s["name"], ", ".join(u["name"] for u in s["usedBy"])) for s in d if s["id"] == env["SKILL_ID"])'

  request GET "/configurations/$BASELINE_ID/draft"
  EDIT_BODY="$(jv 'json.dumps(dict(d["values"], maxTurns=25))' 2>/dev/null)"
  check 'GET /configurations/:id/draft (edit of an unused version)' 200 \
    'd["mode"] == "edit" and not d["createsNewVersion"]' \
    '"mode {} · creates a new version: {}".format(d["mode"], d["createsNewVersion"])'
  send_json PUT "/configurations/$BASELINE_ID" "$EDIT_BODY"
  check 'PUT /configurations/:id saves it in place' 200 \
    'd["version"] == 1 and not d["createdNewVersion"]' \
    '"version {} · new version: {}".format(d["version"], d["createdNewVersion"])'

  request GET /configurations
  check 'GET /configurations lists both' 200 \
    '{env["BASELINE_NAME"], env["WITH_MCP_NAME"]} <= {c["name"] for c in d}' \
    '"{} configurations".format(len(d))'
fi

# ---------------------------------------------------------------------------
section 'System'
# ---------------------------------------------------------------------------

request GET /system/summary
check 'GET /system/summary' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] for w in d["workers"])' \
  '"running {} · queued runs {} · workers: {}".format(d["running"]["count"], d["queuedRuns"], ", ".join("{} {}".format(w["id"], w["status"]) for w in d["workers"]))'

request GET /system/workers
check 'GET /system/workers' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] and w["concurrency"] >= 1 for w in d)' \
  '"; ".join("{} {} · concurrency {} · slots {}/{} · sandbox {}".format(w["id"], w["status"], w["concurrency"], w["slotsInUse"], w["slotsTotal"], "proven" if w["sandboxProven"] else "NOT proven") for w in d if w["status"] == "online")'

request GET /system/sandbox
check 'GET /system/sandbox' 200 \
  'd["proven"] and len(d["checks"]) == 15 and all(c["passed"] for c in d["checks"])' \
  '"proven · {}/{} checks passed · {} · {} at {}".format(sum(c["passed"] for c in d["checks"]), len(d["checks"]), d["revision"], d["trigger"], d["checkedAt"])'

request GET /resources/counts
check 'GET /resources/counts' 200 \
  'd["skills"] >= 1 and d["documents"] >= 1 and d["mcpServers"] >= 2 and d["secrets"] >= 2' \
  '"skills {skills} · documents {documents} · MCP servers {mcpServers} · secrets {secrets}".format_map(d)'

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILS" "$SKIPS"
[ "$FAILS" -eq 0 ]
