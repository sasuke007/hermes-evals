#!/usr/bin/env bash
# Phase 6 smoke test: the platform additions and invoices-v1 on a running
# Hermes Evals stack, in real trial containers, with real Hermes against the
# scripted mock model, printing one PASS/FAIL/SKIP line per step. It covers
# the live half of Phase 6's exit (plan 17):
#
# - the generators reproduce their bytes (scripts/fixtures/sample-mcp.ts
#   --check, scripts/fixtures/invoices-v1.ts against the repository's
#   suite and mock scripts), and the sample MCP servers pass their own
#   checks in the vendor-directory image (docker/mcp/check_samples.py);
# - invoices-v1 loads 12 of 12 valid; the invoice-method skill (zipped from
#   samples/skills/invoice-method) validates and is stored or already is;
# - the mock-model experiment on invoices-v1, `baseline` against
#   `with-skill`, 2 repetitions: every primary key passes with the skill;
#   without it total_due, overdue_list, vat_split and missing_po pass and
#   the other eight fall into their traps, so the comparison reads `better`,
#   pass rates 8/24 -> 24/24;
# - a temporary suite and skill written by scripts/fixtures/phase6-smoke.ts,
#   whose mock scripts answer right only when the addition reaches the run:
#   codeword (skill loading: preloaded with -s, and on demand with no -s,
#   the skills toolset and a skill_view call), currency (a seeded USER.md
#   reaches the prompt only with memory on; memory on brings the `memory`
#   toolset itself, so both arms configure file and terminal only), remember
#   (the memory file the agent saves is collected with root home and scored
#   by a file_check with `root: home`; the model calls are counted, so a
#   background review fork would show), vendors (vendor-directory answers
#   through egress's MCP gateway, which adds its header, and the trial
#   cannot reach it itself), ledger (invoice-db, the stdio sample, pages 20
#   invoices at a time with a cursor; the mock's log shows both pages as the
#   model received them). Each MCP run ends by asking its server for a name
#   it does not hold, and the server's not-found reply, which only it writes
#   and only for these runs, is what lets the mock answer right;
# - the launch 409 for an MCP variable that is not set, and New
#   experiment's options naming it: a stdio variable the worker lacks, and,
#   with SMOKE_RESTART=1, VENDOR_DIRECTORY_TOKEN with egress recreated
#   without it (then put back).
#
#   scripts/phase6-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase6-smoke.sh  # through nginx
#
# The stack needs the Phase 6 images, the mock model (on every start since Phase 8) with
# scripts/phase6-mock-scripts.json, the mock as the judge (disputed has an
# llm_judge key), INVOICE_DB_URL for the worker (the ledger checks), and,
# for the vendors checks, the sample http MCP server (on every start since Phase 8)
# with VENDOR_DIRECTORY_TOKEN (any random string; without it those checks
# expect the launch 409 instead). Compose reads every one of them from the
# shell before .env, so no file changes. Give the mock every
# scripts/*mock-scripts.json, so the other smoke tests (Phases 2 to 4 and
# 6b) pass on the same stack; the order does not matter, since each script
# matches a phrase only its own runs hold (apps/api/test/phase6-smoke.spec.ts
# checks the Phase 6 smoke's against every scripts/*mock-scripts.json, and
# phase6b-mock-scripts.spec.ts the suites'):
#
#   export VENDOR_DIRECTORY_TOKEN="$(openssl rand -hex 16)" INVOICE_DB_URL=file:///opt/mcp/invoice-db/invoices.csv
#   MOCK_SCRIPTS_FILE=./scripts \
#   JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
#     docker compose up -d --build
#
# (Compose mounts the directory MOCK_SCRIPTS_FILE names into the mock, which
# reads every *.json file in it in name order.)
#
# With SMOKE_RESTART=1, run the smoke from a shell with the same
# VENDOR_DIRECTORY_TOKEN (or none, when .env holds it or neither sets it and
# Compose gives its sample value): the step that
# recreates egress puts the value back from there, and only after checking,
# by hash, that it is the one egress has. Without it that step is skipped,
# since a smoke test should not recreate a service unless asked.
#
# Every configuration uses provider `custom` with base URL
# http://mock-model:8090/v1 and model mock/scripted, which config/prices.yaml
# prices at 0: no real provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl, python3 and node (22.18+, which runs the
# TypeScript generators). Exits 0 only when no step failed. It writes to the
# stack it tests, so point it at a development stack only. Names it creates
# start with smoke-<UTC timestamp> (the suite directory zz-smoke-p6-<timestamp>),
# so it can run again and again. Three names are fixed because the mock
# scripts name them: the skill smoke-phase6-lookup and the MCP servers
# vendor-directory and invoice-db (the two samples, as README defines them),
# which a second run reuses. The suite directory is removed at the end and
# reloaded, which leaves its suite_sources row `missing`; the experiments,
# configurations, skills and servers stay. On Colima, export
# DOCKER_CONTEXT=colima so the docker checks run.
#
# Settings (environment):
#   BASE_URL       API base URL (default http://localhost:3000/api)
#   SUITES_DIR     host directory the worker reads suites from (default <repo>/suites)
#   SMOKE_DOCKER   auto (default) | 0: also check, read-only through docker, the
#                  mock's scripts and its request log, migration 0008, egress's stored
#                  connection log and the sample MCP checks
#   SMOKE_RESTART  0 (default) | 1: for the 409 of an http header variable, recreate
#                  egress without VENDOR_DIRECTORY_TOKEN, then with it again (needs the
#                  docker checks, the token egress has, and no trial running). It
#                  checks that the token reaches egress, not egress's token cap. Off,
#                  the step prints a SKIP line saying how to run it.
#   RUN_TIMEOUT    seconds the experiments may take together (default 900)
#   CURL_TIMEOUT   seconds per request (default 120)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
SMOKE_RESTART="${SMOKE_RESTART:-0}"
RUN_TIMEOUT="${RUN_TIMEOUT:-900}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
SUITE_NAME="zz-smoke-p6-$STAMP"
SUITE_DIR="$SUITES_DIR/$SUITE_NAME"
SMOKE_SKILL='smoke-phase6-lookup'
VENDOR_SERVER='vendor-directory'
INVOICE_SERVER='invoice-db'
UNSET_SERVER="$PREFIX-unset-db"
UNSET_VAR='SMOKE_PHASE6_UNSET_VALUE'
# invoice-db's cursors for the second and third pages of the unfiltered
# listing (base64url of [offset,null,null], docker/mcp/invoice-db/server.py).
CURSOR2='WzIwLG51bGwsbnVsbF0'
CURSOR3='WzQwLG51bGwsbnVsbF0'
# The servers' not-found replies to the probes of the vendors and ledger
# runs (scripts/fixtures/phase6-smoke.ts): the phrases that answer them right.
VENDOR_REPLY='no vendor smoke-phase6-probe-vendor'
LEDGER_REPLY='no invoice smoke-phase6-probe-invoice'
export PREFIX SUITE_NAME SMOKE_SKILL VENDOR_SERVER INVOICE_SERVER UNSET_SERVER UNSET_VAR CURSOR2 CURSOR3 VENDOR_REPLY LEDGER_REPLY

for tool in curl python3 node; do
  command -v "$tool" >/dev/null || { echo "phase6-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase6-smoke.XXXXXX")"
export WORK
BODY="$WORK/body"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
EGRESS_CHANGED=0

# ---------------------------------------------------------------------------
# Helpers (as in phase4-smoke.sh)
# ---------------------------------------------------------------------------

# request METHOD PATH [curl args...]: the body lands in $BODY and the status
# in $STATUS (000 when curl itself failed, with its error as the body).
# State-changing requests carry X-Requested-With.
request() {
  local method="$1" path="$2"
  shift 2
  if [ "$method" = GET ]; then
    STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
  else
    STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time "$CURL_TIMEOUT" -X "$method" \
      -H 'X-Requested-With: phase6-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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

# jv EXPR [FILE]: a Python expression over the JSON in FILE (default the last
# response) as `d`, with `env`, `json`, `raw`, `sc` (sc(run, key): that score
# row of a run detail), `primary` (primary(runs, task, config): the primary
# status of that task's runs under that configuration in a run list, every
# repetition alike, or the statuses joined by "/"), `calls` (calls(run): the
# model calls of a run detail's timeline), `stats` (stats(comparison): its
# verdict and figures) and `mcp_result` (mcp_result(text): the tool's JSON in
# an MCP tool result as Hermes hands it to the model). str.format, not
# f-strings (Python before 3.12).
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
def sc(run, key):
    return next(s for s in run['scores'] if s['key'] == key)
def primary(runs, task, config):
    got = sorted({(r['primaryScore'] or {}).get('status') or 'none' for r in runs['rows']
                  if r['taskKey'] == task and r['configuration']['name'] == config})
    return '/'.join(got) or 'missing'
def calls(run):
    return sum(1 for e in run['timeline']['events'] if e['kind'] == 'network' and e['network']['kind'] == 'model')
def stats(view):
    s = view['statistics']
    return (s['verdict'], round(s['observedDelta'], 3), s['lo'] > 0)
def mcp_result(text):
    # <untrusted_tool_result ...>preamble {"result": "<the tool's JSON>"}</untrusted_tool_result>
    return json.loads(json.loads(text[text.index('{"result"'):text.rindex('}') + 1])['result'])
try:
    value = eval(expr, {'d': d, 'env': os.environ, 'json': json, 'raw': raw, 'sc': sc,
                        'primary': primary, 'calls': calls, 'stats': stats, 'mcp_result': mcp_result})
except Exception as exc:
    print('{}: {}'.format(type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
print(value if isinstance(value, str) else json.dumps(value))
PY
}

line() { printf '%-5s %-66s %s\n' "$1" "$2" "$3"; }
pass() { PASSES=$((PASSES + 1)); line PASS "$1" "${2:-}"; }
fail() { FAILS=$((FAILS + 1)); line FAIL "$1" "${2:-}"; }
skip() { SKIPS=$((SKIPS + 1)); line SKIP "$1" "${2:-}"; }
snippet() { tr '\n' ' ' <"$BODY" | cut -c1-300; }
section() { printf '\n== %s\n' "$1"; }

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

# check_file NAME FILE EXPR [DETAIL]: check over a JSON file instead of a response.
check_file() {
  cp "$2" "$BODY"
  STATUS=200
  check "$1" 200 "$3" "${4:-}"
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

# wait_for PATH EXPR TIMEOUT: polls GET PATH every 2 s until EXPR is true over
# its body; returns 1 on timeout. The last response stays in $BODY.
wait_for() {
  local path="$1" expr="$2" timeout="$3" start
  start="$(date +%s)"
  while :; do
    request GET "$path"
    if [ "$STATUS" = 200 ] && [ "$(jv "$expr" 2>/dev/null)" = true ]; then return 0; fi
    [ $(($(date +%s) - start)) -ge "$timeout" ] && return 1
    sleep 2
  done
}

# zip_dir DIR ZIP: the folder's files at the zip's root, as a skill upload wants them.
zip_dir() {
  python3 - "$1" "$2" <<'PY'
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in sorted(os.walk(root)):
        for name in sorted(files):
            full = os.path.join(base, name)
            z.write(full, os.path.relpath(full, root))
PY
}

# Docker checks run when the stack is this repository's Compose project here.
DOCKER=0
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null &&
  (cd "$REPO_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx worker); then
  DOCKER=1
fi
dc() { (cd "$REPO_DIR" && docker compose "$@"); }
psql_ro() { dc exec -T postgres psql -U hermes -d hermes_evals -At -c "$1" 2>/dev/null; }
# The mock's log of every request it received (GET /__requests), into FILE.
mock_requests() {
  dc exec -T mock-model node -e "fetch('http://localhost:8090/__requests').then(r=>r.text()).then(t=>process.stdout.write(t))" >"$1" 2>/dev/null
}
# token_hashes: the sha256 of the VENDOR_DIRECTORY_TOKEN egress holds, and of
# the one Compose would give it from this shell and .env, on one line. Only
# the hashes leave the two processes, never the value.
token_hashes() {
  local running composed
  running="$(dc exec -T egress node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.env.VENDOR_DIRECTORY_TOKEN || '').digest('hex'))" 2>/dev/null)"
  composed="$(dc config --format json 2>/dev/null | python3 -c "import hashlib, json, sys; print(hashlib.sha256((json.load(sys.stdin)['services']['egress'].get('environment', {}).get('VENDOR_DIRECTORY_TOKEN') or '').encode()).hexdigest())" 2>/dev/null)"
  echo "${running:-none} ${composed:-none}"
}
# egress_up [TOKEN]: recreates egress, with VENDOR_DIRECTORY_TOKEN as given
# (empty: unset) or, with no argument, as this shell and .env have it.
egress_up() {
  if [ $# -ge 1 ]; then
    VENDOR_DIRECTORY_TOKEN="$1" dc up -d --no-deps egress >"$WORK/compose.log" 2>&1
  else
    dc up -d --no-deps egress >"$WORK/compose.log" 2>&1
  fi
}
# token_seen SET: waits until GET /resources/secrets reports
# VENDOR_DIRECTORY_TOKEN set (true) or not (false), as the worker's next
# heartbeat reads egress's names.
token_seen() {
  WANT="$1" wait_for /resources/secrets \
    'next(r["set"] for r in d if r["name"] == "VENDOR_DIRECTORY_TOKEN") == (env["WANT"] == "true")' 90
}

# Puts egress's token back if a step took it away, removes the temporary
# suite directory (and reloads it, so it is `missing`), then the work directory.
cleanup() {
  if [ "$EGRESS_CHANGED" = 1 ]; then
    egress_up || echo "phase6-smoke: could not recreate egress with its VENDOR_DIRECTORY_TOKEN" >&2
  fi
  if [ -d "$SUITE_DIR" ]; then
    rm -rf "$SUITE_DIR"
    send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'Phase 6 smoke · %s · stamp %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

# ---------------------------------------------------------------------------
section 'Generators and the sample MCP servers'
# ---------------------------------------------------------------------------

if node "$REPO_DIR/scripts/fixtures/sample-mcp.ts" --check >"$WORK/gen.out" 2>&1; then
  pass 'sample-mcp.ts --check: invoices.csv and vendors.json as generated' "$(tail -1 "$WORK/gen.out")"
else
  fail 'sample-mcp.ts --check: invoices.csv and vendors.json as generated' "$(tail -3 "$WORK/gen.out" | tr '\n' ' ')"
fi

if node "$REPO_DIR/scripts/fixtures/invoices-v1.ts" --out "$WORK/gen" >"$WORK/gen.out" 2>&1; then
  # Hand-written files (task.yaml, most prompts, verifiers) exist only in the repository.
  DIFFS="$( (diff -rq "$WORK/gen/suites/invoices-v1" "$SUITES_DIR/invoices-v1" | grep -v "^Only in $SUITES_DIR/invoices-v1") 2>&1)"
  if [ -z "$DIFFS" ] && cmp -s "$WORK/gen/scripts/phase6-mock-scripts.json" "$REPO_DIR/scripts/phase6-mock-scripts.json"; then
    pass 'invoices-v1.ts reproduces the suite and the mock scripts' 'fixtures, references, expected files, prompts, phase6-mock-scripts.json'
  else
    fail 'invoices-v1.ts reproduces the suite and the mock scripts' "$(printf '%s' "$DIFFS" | head -3 | tr '\n' ' ') (mock scripts: $(cmp -s "$WORK/gen/scripts/phase6-mock-scripts.json" "$REPO_DIR/scripts/phase6-mock-scripts.json" && echo same || echo differ))"
  fi
else
  fail 'invoices-v1.ts reproduces the suite and the mock scripts' "$(tail -3 "$WORK/gen.out" | tr '\n' ' ')"
fi

if [ "$DOCKER" = 1 ] && docker image inspect hermes-evals/vendor-directory >/dev/null 2>&1; then
  if docker run --rm --network none -v "$REPO_DIR/docker/mcp:/checks:ro" \
    --entrypoint /opt/hermes/.venv/bin/python hermes-evals/vendor-directory /checks/check_samples.py \
    >"$WORK/samples.out" 2>&1 && tail -1 "$WORK/samples.out" | grep -q 'all sample MCP checks passed'; then
    pass 'docker/mcp/check_samples.py in the vendor-directory image' "$(grep -c '^ok' "$WORK/samples.out" || true) checks · $(tail -1 "$WORK/samples.out")"
  else
    fail 'docker/mcp/check_samples.py in the vendor-directory image' "$(tail -3 "$WORK/samples.out" | tr '\n' ' ')"
  fi
else
  skip 'docker/mcp/check_samples.py in the vendor-directory image' 'no docker here, or build it: docker compose build vendor-directory'
fi

# ---------------------------------------------------------------------------
section 'Stack'
# ---------------------------------------------------------------------------

request GET /health
check 'GET /health' 200 \
  'd["status"] == "ok" and all(v == "ok" for v in d["checks"].values())' \
  '"status " + d["status"] + " · " + ", ".join(k + " " + v for k, v in d["checks"].items())'

request GET /system/workers
check 'GET /system/workers: online, sandbox proven' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] for w in d)' \
  '"; ".join("{} effective concurrency {}".format(w["id"], w["effectiveConcurrency"]) for w in d if w["status"] == "online")'

if [ "$DOCKER" = 1 ]; then
  if dc exec -T mock-model node dist/mock-model.js --print-scripts 2>/dev/null | grep 'smoke-phase6-codeword' >/dev/null; then
    pass 'the mock model has scripts/phase6-mock-scripts.json' 'its scripts match smoke-phase6-codeword, the skill sentence, ...'
  else
    fail 'the mock model has scripts/phase6-mock-scripts.json' 'start it as the header says (MOCK_SCRIPTS_FILE)'
  fi
  ROOT_COL="$(psql_ro "select count(*) from information_schema.columns where table_name = 'artifacts' and column_name = 'root'")"
  LOADING_COL="$(psql_ro "select count(*) from information_schema.columns where table_name = 'configuration_versions' and column_name = 'skill_loading'")"
  if [ "$ROOT_COL" = 1 ] && [ "$LOADING_COL" = 1 ]; then
    pass 'migration 0008: artifacts.root and configuration_versions.skill_loading' "$(psql_ro 'select count(*) from drizzle.__drizzle_migrations') migrations applied"
  else
    fail 'migration 0008: artifacts.root and configuration_versions.skill_loading' "root ${ROOT_COL:-?} · skill_loading ${LOADING_COL:-?}; rebuild the api image"
  fi
else
  skip 'the mock scripts, migration 0008' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section 'invoices-v1 and the invoice-method skill'
# ---------------------------------------------------------------------------

request GET /suites
check 'invoices-v1: 12 of 12 tasks valid' 200 \
  'any(s["name"] == "invoices-v1" and s["taskCount"] == s["validCount"] == 12 for s in d)' \
  '"; ".join("{name} v{versionNumber} {validCount}/{taskCount} valid".format_map(s) for s in d if s["name"] == "invoices-v1")'
INVOICES_ID="$(jv 'next(s["suiteId"] for s in d if s["name"] == "invoices-v1")' 2>/dev/null)"
export INVOICES_ID
if need 'summary_file: its self-check and negative controls' "$INVOICES_ID"; then
  request GET "/suites/$INVOICES_ID/tasks/summary_file"
  check 'summary_file: passes on the expected workspace, fails on the fixtures' 200 \
    'd["valid"] and d["selfCheck"]["status"] == "passed" and all("fails on the untouched fixtures" in r["note"] for r in d["selfCheck"]["results"] if r["type"] in ("file_check", "verifier_script"))' \
    '"; ".join("{key}: {note}".format_map(r) for r in d["selfCheck"]["results"])'
fi

zip_dir "$REPO_DIR/samples/skills/invoice-method" "$WORK/invoice-method.zip"
# upload_skill ZIP NAME: validates, then confirms or reuses the stored copy; sets SKILL_ID.
upload_skill() {
  SKILL_ID=''
  request POST /resources/skills/validate -F "file=@$1;type=application/zip"
  NAME="$2" check "POST /resources/skills/validate $2" 200 \
    'd["name"] == env["NAME"] and (d["outcome"] in ("valid", "new_version") or (d["outcome"] == "conflict" and d["problems"][0]["title"] == "Already uploaded."))' \
    '"{outcome} · {version} · ".format_map(d) + ", ".join(f["path"] for f in d["fileTree"])' || return 0
  if [ "$(jv 'd["outcome"]')" = conflict ]; then
    SKILL_ID="$(jv 'd["existing"]["id"]')"
    pass "  $2 is stored already with this content: reused" "$SKILL_ID"
    return 0
  fi
  send_json POST /resources/skills "{\"token\":\"$(jv 'd["token"]')\"}"
  NAME="$2" check "  POST /resources/skills $2 (confirm)" 201 'd["name"] == env["NAME"]' '"{name}@{version} · {id}".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
}
upload_skill "$WORK/invoice-method.zip" invoice-method
METHOD_SKILL="$SKILL_ID"

# ---------------------------------------------------------------------------
section "Temporary suite (suites/$SUITE_NAME) and the smoke skill"
# ---------------------------------------------------------------------------

if node "$REPO_DIR/scripts/fixtures/phase6-smoke.ts" --suite "$SUITE_DIR" --name "$SUITE_NAME" --skill "$WORK/skill" >"$WORK/gen.out" 2>&1; then
  pass 'phase6-smoke.ts wrote the suite and the skill' "codeword, currency, remember, vendors, ledger · $SMOKE_SKILL"
else
  fail 'phase6-smoke.ts wrote the suite and the skill' "$(tail -3 "$WORK/gen.out" | tr '\n' ' ')"
fi
send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
check 'reload the new directory -> created v1' 200 \
  'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1' \
  '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
SUITE_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"
export SUITE_ID

if need 'temporary suite: 5 valid tasks' "$SUITE_ID"; then
  request GET "/suites/$SUITE_ID"
  check 'temporary suite: 5 valid tasks' 200 \
    'd["validCount"] == d["taskCount"] == 5' \
    '", ".join("{} {}".format(t["key"], "valid" if t["valid"] else "INVALID") for t in d["tasks"])'
  request GET "/suites/$SUITE_ID/tasks/currency"
  check '  currency: its USER.md seed on Task detail, never a fixture' 200 \
    '[(f["kind"], f["path"]) for f in d["homeFiles"]] == [("home_seed", "home/memories/USER.md")] and "smoke-phase6-seed" in d["homeFiles"][0]["text"] and d["fixtures"] == []' \
    '"{kind} {path} · {sizeBytes} bytes".format_map(d["homeFiles"][0])'
  request GET "/suites/$SUITE_ID/tasks/remember"
  check '  remember: the home check passes on the expected home, fails on the seed' 200 \
    '[f["kind"] for f in d["homeFiles"]] == ["home_seed", "expected_home"] and next(r for r in d["selfCheck"]["results"] if r["key"] == "saved")["note"] == "passes on the expected home; fails on the home seeds alone, as it should"' \
    'next(v["sentence"] for v in d["verification"] if v["key"] == "saved")'
fi

zip_dir "$WORK/skill" "$WORK/smoke-skill.zip"
upload_skill "$WORK/smoke-skill.zip" "$SMOKE_SKILL"
LOOKUP_SKILL="$SKILL_ID"

# ---------------------------------------------------------------------------
section 'Configurations and MCP servers'
# ---------------------------------------------------------------------------

# config_body NAME TOOLSETS MEMORY SKILL_IDS LOADING MCP_IDS: a configuration on the mock model.
config_body() {
  printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":[%s],"memoryEnabled":%s,"skillIds":[%s],"skillLoading":"%s","documentIds":[],"mcpServerVersionIds":[%s],"maxTurns":10,"timeBudgetS":180,"duplicatedFromVersionId":null}' \
    "$1" "$2" "$3" "$4" "$5" "$6"
}
# create_config NAME LABEL BODY-ARGS...: POST /configurations; sets VERSION_ID.
create_config() {
  local name="$1" label="$2"
  shift 2
  VERSION_ID=''
  send_json POST /configurations "$(config_body "$name" "$@")"
  check "POST /configurations $name ($label)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)' || return 0
  VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
}
FT='"file","terminal"'
create_config "$PREFIX-baseline" 'file, terminal' "$FT" false '' preload ''
BASELINE="$VERSION_ID"
WITH_SKILL=''
if need "POST /configurations $PREFIX-with-skill" "$METHOD_SKILL"; then
  create_config "$PREFIX-with-skill" 'invoice-method, preloaded' "$FT" false "\"$METHOD_SKILL\"" preload ''
  WITH_SKILL="$VERSION_ID"
fi
PRELOAD=''
ON_DEMAND=''
if need "POST /configurations $PREFIX-preload, $PREFIX-on-demand" "$LOOKUP_SKILL"; then
  create_config "$PREFIX-preload" "$SMOKE_SKILL, preloaded" "$FT" false "\"$LOOKUP_SKILL\"" preload ''
  PRELOAD="$VERSION_ID"
  create_config "$PREFIX-on-demand" "$SMOKE_SKILL, on demand" "$FT" false "\"$LOOKUP_SKILL\"" on_demand ''
  ON_DEMAND="$VERSION_ID"
fi
# The arms differ only in memory_enabled: memory on brings Hermes's `memory`
# toolset, whose tool saves to the stores, at launch (lifecycle/plan.ts
# plannedToolsets), so neither configuration lists it.
create_config "$PREFIX-memory-off" 'memory off' "$FT" false '' preload ''
MEMORY_OFF="$VERSION_ID"
create_config "$PREFIX-memory-on" 'memory on' "$FT" true '' preload ''
MEMORY_ON="$VERSION_ID"
export BASELINE WITH_SKILL PRELOAD ON_DEMAND MEMORY_OFF MEMORY_ON

send_json POST /configurations "$(config_body "$PREFIX-on-demand-nothing" "$FT" false '' on_demand '')"
check 'on demand with no skill is refused (400)' 400 \
  'any(i["path"] == "skillLoading" and i["message"] == "Skill loading applies only when the configuration has skills" for i in d["issues"])' \
  'd["issues"][0]["message"]'
if need 'GET /configurations/diff: preload against on demand' "$PRELOAD" "$ON_DEMAND"; then
  request GET "/configurations/diff?versions=$PRELOAD,$ON_DEMAND"
  check 'GET /configurations/diff: preload against on demand' 200 \
    'next(r for r in d["rows"] if r["field"] == "skill_loading") == {"field": "skill_loading", "values": ["preload", "on demand"], "differs": True}' \
    '"differing: " + ", ".join(d["differing"])'
fi

# The two sample servers, by fixed names, since the mock calls
# mcp__vendor_directory__list_vendors and mcp__invoice_db__list_invoices.
# sample_server NAME DEFINITION EXPR: reuses the stored server of that name
# when its latest version passes EXPR, updates it to DEFINITION when it does
# not, else creates it; sets SERVER_ID and SERVER_VERSION.
sample_server() {
  SERVER_ID=''
  SERVER_VERSION=''
  request GET /resources/mcp-servers
  if [ "$(NAME="$1" jv 'any(r["name"] == env["NAME"] for r in d)' 2>/dev/null)" = true ]; then
    NAME="$1" jv 'json.dumps(next(r for r in d if r["name"] == env["NAME"]))' >"$WORK/server.json"
    if [ "$(jv "$3" "$WORK/server.json" 2>/dev/null)" = true ]; then
      check_file "MCP server $1 (stored already: reused)" "$WORK/server.json" "$3" '"v{version} · {transport}".format_map(d)' || return 0
    else
      # Stored with another definition (vendor-directory before Phase 7 had no
      # `Bearer ` prefix): update it, which makes its next version if frozen.
      send_json PUT "/resources/mcp-servers/$(jv 'd["id"]' "$WORK/server.json" 2>/dev/null)" "$2"
      NAME="$1" check "MCP server $1 (stored with another definition: updated)" 200 "d[\"name\"] == env[\"NAME\"] and $3" '"v{version} · {transport}".format_map(d)' || return 0
    fi
  else
    send_json POST /resources/mcp-servers "$2"
    NAME="$1" check "POST /resources/mcp-servers $1" 201 "d[\"name\"] == env[\"NAME\"] and $3" '"v{version} · {transport}".format_map(d)' || return 0
  fi
  SERVER_ID="$(jv 'd["id"]' 2>/dev/null)"
  SERVER_VERSION="$(jv 'd["versionId"]' 2>/dev/null)"
}
sample_server "$VENDOR_SERVER" \
  '{"name":"vendor-directory","transport":"http","command":null,"args":[],"envNames":[],"url":"http://vendor-directory:8000/mcp","headers":[{"header":"Authorization","env":"VENDOR_DIRECTORY_TOKEN","prefix":"Bearer "}],"include":[],"exclude":[],"timeoutS":30}' \
  'd["transport"] == "http" and d["url"] == "http://vendor-directory:8000/mcp" and d["headers"] == [{"header": "Authorization", "env": "VENDOR_DIRECTORY_TOKEN", "prefix": "Bearer "}]'
VENDORS_ID="$SERVER_ID"
VENDORS_VERSION="$SERVER_VERSION"
sample_server "$INVOICE_SERVER" \
  '{"name":"invoice-db","transport":"stdio","command":"invoice-db-mcp","args":[],"envNames":["INVOICE_DB_URL"],"url":null,"headers":[],"include":[],"exclude":[],"timeoutS":30}' \
  'd["transport"] == "stdio" and d["command"] == "invoice-db-mcp" and d["envNames"] == ["INVOICE_DB_URL"]'
LEDGER_ID="$SERVER_ID"
LEDGER_VERSION="$SERVER_VERSION"
send_json POST /resources/mcp-servers "{\"name\":\"$UNSET_SERVER\",\"transport\":\"stdio\",\"command\":\"invoice-db-mcp\",\"args\":[],\"envNames\":[\"$UNSET_VAR\"],\"url\":null,\"headers\":[],\"include\":[],\"exclude\":[],\"timeoutS\":30}"
check "POST /resources/mcp-servers $UNSET_SERVER (stdio, $UNSET_VAR)" 201 'd["envNames"] == [env["UNSET_VAR"]]' '"v{version} · {command}".format_map(d)'
UNSET_VERSION="$(jv 'd["versionId"]' 2>/dev/null)"

request GET /resources/secrets
TOKEN_SET="$(jv 'next((r["set"] for r in d if r["name"] == "VENDOR_DIRECTORY_TOKEN" and r["source"] == "egress"), False)' 2>/dev/null)"
INVOICE_DB_SET="$(jv 'next((r["set"] for r in d if r["name"] == "INVOICE_DB_URL" and r["source"] == "worker"), False)' 2>/dev/null)"
check 'GET /resources/secrets: VENDOR_DIRECTORY_TOKEN egress only; INVOICE_DB_URL; the unset name' 200 \
  'any(r["name"] == "VENDOR_DIRECTORY_TOKEN" and r["source"] == "egress" and r["exposure"] == "egress_only" for r in d) and any(r["name"] == "INVOICE_DB_URL" and r["source"] == "worker" and r["exposure"] == "readable_by_agent" for r in d) and any(r["name"] == env["UNSET_VAR"] and not r["set"] for r in d)' \
  '"VENDOR_DIRECTORY_TOKEN " + ("set" if next(r["set"] for r in d if r["name"] == "VENDOR_DIRECTORY_TOKEN") else "not set (the vendors run expects the 409)") + " · INVOICE_DB_URL " + ("set" if next(r["set"] for r in d if r["name"] == "INVOICE_DB_URL") else "not set (the ledger run expects the 409)")'
export TOKEN_SET INVOICE_DB_SET

WITH_VENDORS=''
if need "POST /configurations $PREFIX-with-vendors" "$VENDORS_VERSION"; then
  create_config "$PREFIX-with-vendors" "$VENDOR_SERVER" "$FT" false '' preload "\"$VENDORS_VERSION\""
  WITH_VENDORS="$VERSION_ID"
fi
WITH_LEDGER=''
if need "POST /configurations $PREFIX-with-ledger" "$LEDGER_VERSION"; then
  create_config "$PREFIX-with-ledger" "$INVOICE_SERVER" "$FT" false '' preload "\"$LEDGER_VERSION\""
  WITH_LEDGER="$VERSION_ID"
fi
UNSET_CONFIG=''
if need "POST /configurations $PREFIX-unset" "$UNSET_VERSION"; then
  create_config "$PREFIX-unset" "$UNSET_SERVER" "$FT" false '' preload "\"$UNSET_VERSION\""
  UNSET_CONFIG="$VERSION_ID"
fi
export WITH_VENDORS WITH_LEDGER UNSET_CONFIG

if [ "$TOKEN_SET" = true ] && need "Test start $VENDOR_SERVER" "$VENDORS_ID"; then
  send_json POST "/resources/mcp-servers/$VENDORS_ID/test"
  check "Test start $VENDOR_SERVER through egress -> passed, 2 tools" 200 \
    'd["status"] == "passed" and sorted(t["name"] for t in d["tools"]) == ["get_vendor", "list_vendors"]' \
    '"{} in {} ms · tools: {}".format(d["status"], d["startedMs"], ", ".join(t["name"] for t in d["tools"]))'
elif [ "$TOKEN_SET" != true ]; then
  skip "Test start $VENDOR_SERVER through egress" 'VENDOR_DIRECTORY_TOKEN is not set in egress (see the header)'
fi
if [ "$INVOICE_DB_SET" = true ] && need "Test start $INVOICE_SERVER" "$LEDGER_ID"; then
  send_json POST "/resources/mcp-servers/$LEDGER_ID/test"
  check "Test start $INVOICE_SERVER on the worker -> passed, 4 tools" 200 \
    'd["status"] == "passed" and sorted(t["name"] for t in d["tools"]) == ["delete_invoice", "get_invoice", "list_invoices", "update_invoice"]' \
    '"{} in {} ms · tools: {}".format(d["status"], d["startedMs"], ", ".join(t["name"] for t in d["tools"]))'
elif [ "$INVOICE_DB_SET" != true ]; then
  skip "Test start $INVOICE_SERVER on the worker" 'the worker lacks INVOICE_DB_URL (see the header)'
fi

request GET /experiments/new-options
cp "$BODY" "$WORK/options.json"
check 'GET /experiments/new-options: the unset variable on its configuration' 200 \
  'next(c for c in d["configurations"] if c["versionId"] == env["UNSET_CONFIG"])["missingSecrets"] == [{"server": env["UNSET_SERVER"], "name": env["UNSET_VAR"], "transport": "stdio"}] and next(c for c in d["configurations"] if c["versionId"] == env["BASELINE"])["missingSecrets"] == [] and next(c for c in d["configurations"] if c["versionId"] == env["ON_DEMAND"])["skillLoading"] == "on_demand"' \
  'json.dumps(next(c for c in d["configurations"] if c["versionId"] == env["UNSET_CONFIG"])["missingSecrets"])'
CONCURRENCY="$(jv 'max(1, min(3, d["maxConcurrency"]))' 2>/dev/null || echo 3)"
export CONCURRENCY

# launch SUITE_ID NAME TASKS BASELINE CANDIDATES [REPETITIONS]: POST
# /experiments (one repetition unless given); CANDIDATES is a
# comma-separated list of version ids. The id lands in $EXP when the launch
# is accepted.
launch() {
  local body
  EXP=''
  body="$(python3 - "$WORK/options.json" "$@" <<'PY'
import json, sys
options, suite, name, tasks, baseline, candidates = sys.argv[1:7]
repetitions = int(sys.argv[7]) if len(sys.argv) > 7 else 1
o = json.load(open(options))
h = {c['versionId']: c['configHash'] for c in o['configurations']}
cands = candidates.split(',')
print(json.dumps({'name': name, 'description': 'phase6-smoke: ' + name, 'suiteId': suite,
                  'taskKeys': tasks.split(','), 'baselineVersionId': baseline, 'candidateVersionIds': cands,
                  'repetitions': repetitions, 'concurrency': 3, 'spendCeilingUsd': None, 'timeBudgetOverrideS': None,
                  'expectedConfigHashes': {v: h[v] for v in [baseline] + cands}}))
PY
  )" || return 0
  send_json POST /experiments "$body"
  [ "$STATUS" = 201 ] && EXP="$(jv 'd["id"]' 2>/dev/null)"
  return 0
}

if need 'launch with an unset MCP variable -> 409' "$SUITE_ID" "$BASELINE" "$UNSET_CONFIG"; then
  launch "$SUITE_ID" "$PREFIX-unset" codeword "$BASELINE" "$UNSET_CONFIG"
  check 'launch with an unset MCP variable -> 409 naming it' 409 \
    'd["message"].startswith("{}-unset: {} ({}, read by the worker) is not set. ".format(env["PREFIX"], env["UNSET_VAR"], env["UNSET_SERVER"])) and d["issues"] == [{"path": "candidateVersionIds.0", "message": "{} ({}, read by the worker)".format(env["UNSET_VAR"], env["UNSET_SERVER"])}]' \
    'd["message"]'
fi

# ---------------------------------------------------------------------------
section 'Launch'
# ---------------------------------------------------------------------------

# Where this run's requests start in the mock's log (it keeps every request since it started).
MOCK_FROM=0
if [ "$DOCKER" = 1 ] && mock_requests "$WORK/mock.json"; then
  MOCK_FROM="$(jv 'len(d)' "$WORK/mock.json" 2>/dev/null || echo 0)"
fi
export MOCK_FROM
INVOICES_EXP=''
SKILLS_EXP=''
MEMORY_EXP=''
VENDORS_EXP=''
LEDGER_EXP=''
TASKS12='total_due,overdue_list,dup_invoices,vat_split,credit_notes,currency_mix,missing_po,late_fees,per_vendor,disputed,partial_pay,summary_file'
if need 'POST /experiments invoices-v1: baseline, with-skill' "$INVOICES_ID" "$BASELINE" "$WITH_SKILL"; then
  launch "$INVOICES_ID" "$PREFIX-invoices" "$TASKS12" "$BASELINE" "$WITH_SKILL" 2
  check 'POST /experiments invoices-v1: 12 tasks x baseline, with-skill x 2' 201 'bool(d["id"])' '"experiment " + d["id"] + " (a 409 here: is the judge set? see the header)"'
  INVOICES_EXP="$EXP"
fi
if need 'POST /experiments skill loading' "$SUITE_ID" "$BASELINE" "$PRELOAD" "$ON_DEMAND"; then
  launch "$SUITE_ID" "$PREFIX-skills" codeword "$BASELINE" "$PRELOAD,$ON_DEMAND"
  check 'POST /experiments codeword: baseline, preload, on demand' 201 'bool(d["id"])' '"experiment " + d["id"]'
  SKILLS_EXP="$EXP"
fi
if need 'POST /experiments memory' "$SUITE_ID" "$MEMORY_OFF" "$MEMORY_ON"; then
  launch "$SUITE_ID" "$PREFIX-memory" currency,remember "$MEMORY_OFF" "$MEMORY_ON"
  check 'POST /experiments currency, remember: memory off, memory on' 201 'bool(d["id"])' '"experiment " + d["id"]'
  MEMORY_EXP="$EXP"
fi
if need 'POST /experiments vendors' "$SUITE_ID" "$BASELINE" "$WITH_VENDORS"; then
  launch "$SUITE_ID" "$PREFIX-vendors" vendors "$BASELINE" "$WITH_VENDORS"
  if [ "$TOKEN_SET" = true ]; then
    check 'POST /experiments vendors: baseline, with-vendors' 201 'bool(d["id"])' '"experiment " + d["id"]'
    VENDORS_EXP="$EXP"
  else
    check 'POST /experiments vendors without the token -> 409 naming it' 409 \
      '"VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)" in d["message"] and d["issues"][0]["path"] == "candidateVersionIds.0"' \
      'd["message"]'
  fi
fi
if need 'POST /experiments ledger' "$SUITE_ID" "$BASELINE" "$WITH_LEDGER"; then
  launch "$SUITE_ID" "$PREFIX-ledger" ledger "$BASELINE" "$WITH_LEDGER"
  if [ "$INVOICE_DB_SET" = true ]; then
    check 'POST /experiments ledger: baseline, with-ledger' 201 'bool(d["id"])' '"experiment " + d["id"]'
    LEDGER_EXP="$EXP"
  else
    check 'POST /experiments ledger without INVOICE_DB_URL -> 409 naming it' 409 \
      '"INVOICE_DB_URL (invoice-db, read by the worker)" in d["message"]' 'd["message"]'
  fi
fi
export INVOICES_EXP SKILLS_EXP MEMORY_EXP VENDORS_EXP LEDGER_EXP

DEADLINE=$(($(date +%s) + RUN_TIMEOUT))
left() {
  local n=$((DEADLINE - $(date +%s)))
  [ "$n" -lt 1 ] && n=1
  echo "$n"
}
# settles NAME ID RUNS FILE: waits for the experiment to settle, checks it
# completed with RUNS runs scored, and saves its run list in FILE.
settles() {
  if wait_for "/experiments/$2" 'd["status"] in ("completed", "failed", "cancelled")' "$(left)"; then
    RUNS="$3" check "$1: completes, $3 of $3 runs scored" 200 \
      'd["status"] == "completed" and d["counts"]["scored"] == int(env["RUNS"]) and d["totalRuns"] == int(env["RUNS"])' \
      '"{} in {} s".format(d["status"], d["elapsedS"])' || return 1
  else
    fail "$1: completes, $3 of $3 runs scored" "still $(jv 'd["status"]' 2>/dev/null) after ${RUN_TIMEOUT} s"
    return 1
  fi
  request GET "/experiments/$2/runs"
  cp "$BODY" "$4"
}
# run_of FILE TASK CONFIG: the run id of a task under a configuration, from a run list.
run_of() {
  TASK="$2" CONFIG="$3" jv 'next(r["id"] for r in d["rows"] if r["taskKey"] == env["TASK"] and r["configuration"]["name"] == env["CONFIG"])' "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
section 'invoices-v1: the skill against its traps'
# ---------------------------------------------------------------------------

if need 'invoices-v1 experiment' "$INVOICES_EXP" && settles 'invoices-v1' "$INVOICES_EXP" 48 "$WORK/invoices.json"; then
  check_file 'with-skill: every primary key passes, both repetitions' "$WORK/invoices.json" \
    'all(primary(d, t, env["PREFIX"] + "-with-skill") == "passed" for t in sorted({r["taskKey"] for r in d["rows"]}))' \
    '", ".join("{}:{}".format(t, primary(d, t, env["PREFIX"] + "-with-skill")) for t in sorted({r["taskKey"] for r in d["rows"]}))'
  check_file 'baseline: passes 4, falls into the trap of the other 8, both repetitions' "$WORK/invoices.json" \
    'sorted(t for t in {r["taskKey"] for r in d["rows"]} if primary(d, t, env["PREFIX"] + "-baseline") == "passed") == ["missing_po", "overdue_list", "total_due", "vat_split"] and all(primary(d, t, env["PREFIX"] + "-baseline") == "failed" for t in {r["taskKey"] for r in d["rows"]} if t not in ("missing_po", "overdue_list", "total_due", "vat_split"))' \
    '", ".join("{}:{}".format(t, primary(d, t, env["PREFIX"] + "-baseline")) for t in sorted({r["taskKey"] for r in d["rows"]}))'
  request GET "/experiments/$INVOICES_EXP/comparison"
  check 'comparison: better, Δ +0.667, pass rates 8/24 -> 24/24, 8 improved' 200 \
    'stats(d) == ("better", 0.667, True) and not d["provisional"] and d["passCounts"] == {"baseline": {"passed": 8, "counted": 24}, "candidate": {"passed": 24, "counted": 24}} and d["filterCounts"] == {"all": 12, "improved": 8, "regressed": 0, "unchanged": 4} and d["repetitions"] == 2' \
    '"Δ {observedDelta:+.3f} [{lo:+.3f}, {hi:+.3f}] {verdict} · {resamples} resamples".format_map(d["statistics"]) + " · " + ", ".join(r["taskKey"] for r in d["rows"] if r["change"] == "unchanged") + " unchanged"'
  for ARM in baseline with-skill; do
    RUN="$(run_of "$WORK/invoices.json" disputed "$PREFIX-$ARM")"
    if need "  disputed under $ARM: the judge's method score" "$RUN"; then
      request GET "/runs/$RUN"
      WANT="$([ "$ARM" = with-skill ] && echo 0.9 || echo 0.2)" check "  disputed under $ARM: method scored $([ "$ARM" = with-skill ] && echo 0.9 || echo 0.2) by the mock judge" 200 \
        'sc(d, "method")["score"] == float(env["WANT"])' \
        '"method {status} {score}".format_map(sc(d, "method"))'
    fi
  done
  RUN="$(run_of "$WORK/invoices.json" summary_file "$PREFIX-with-skill")"
  if need '  summary_file with-skill: summary.csv written, totals verifier' "$RUN"; then
    request GET "/runs/$RUN"
    check '  summary_file with-skill: summary.csv written, totals verifier passes' 200 \
      'any(a["path"] == "workspace/summary.csv" and a["origin"] == "agent" for a in d["artifacts"]["items"]) and sc(d, "totals")["status"] == "passed"' \
      '"totals {status} {score}".format_map(sc(d, "totals"))'
  fi
fi

# ---------------------------------------------------------------------------
section 'Skill loading (P5): preload with -s, on demand through the skills toolset'
# ---------------------------------------------------------------------------

if need 'skill loading experiment' "$SKILLS_EXP" && settles 'codeword' "$SKILLS_EXP" 3 "$WORK/skills.json"; then
  check_file 'codeword: no skill fails; preloaded and on demand pass' "$WORK/skills.json" \
    '[primary(d, "codeword", env["PREFIX"] + "-" + a) for a in ("baseline", "preload", "on-demand")] == ["failed", "passed", "passed"]' \
    '", ".join("{}:{}".format(a, primary(d, "codeword", env["PREFIX"] + "-" + a)) for a in ("baseline", "preload", "on-demand"))'
  RUN="$(run_of "$WORK/skills.json" codeword "$PREFIX-preload")"
  if need '  preload: -s in the command' "$RUN"; then
    request GET "/runs/$RUN"
    check '  preload: -s smoke-phase6-lookup, no skills toolset, no skill_view' 200 \
      '" -s smoke-phase6-lookup " in d["launchRecord"]["command"] and d["launchRecord"]["container"]["skillLoading"] == "preload" and " -t file,terminal " in d["launchRecord"]["command"] and sc(d, "opened")["status"] == "failed"' \
      '"skillLoading {} · opened {}".format(d["launchRecord"]["container"]["skillLoading"], sc(d, "opened")["status"])'
  fi
  RUN="$(run_of "$WORK/skills.json" codeword "$PREFIX-on-demand")"
  if need '  on demand: no -s, the skills toolset, skill_view' "$RUN"; then
    request GET "/runs/$RUN"
    # skill_view reads the skill from home/skills/, so its body in the result shows it was installed there.
    check '  on demand: installed, no -s, -t file,skills,terminal, opened with skill_view' 200 \
      '" -s " not in d["launchRecord"]["command"] and " -t file,skills,terminal " in d["launchRecord"]["command"] and d["launchRecord"]["container"]["skillLoading"] == "on_demand" and [s["name"] for s in d["launchRecord"]["container"]["skills"]] == [env["SMOKE_SKILL"]] and sc(d, "opened")["status"] == "passed" and any(e["kind"] == "tool" and e["title"] == "skill_view" and "smoke-phase6-skill-body" in (e["output"] or "") for e in d["timeline"]["events"])' \
      '"skillLoading {} · opened {} · {} model calls".format(d["launchRecord"]["container"]["skillLoading"], sc(d, "opened")["status"], calls(d))'
  fi
fi

# ---------------------------------------------------------------------------
section 'Memory (P1, P2, P3): the seed reaches the prompt only with memory on; the saved file is scored'
# ---------------------------------------------------------------------------

if need 'memory experiment' "$MEMORY_EXP" && settles 'memory' "$MEMORY_EXP" 4 "$WORK/memory.json"; then
  check_file 'currency: the seed answers only with memory on' "$WORK/memory.json" \
    '[primary(d, "currency", env["PREFIX"] + "-memory-" + a) for a in ("off", "on")] == ["failed", "passed"]' \
    '"off {} · on {}".format(primary(d, "currency", env["PREFIX"] + "-memory-off"), primary(d, "currency", env["PREFIX"] + "-memory-on"))'
  check_file 'remember: the memory file scores only with memory on' "$WORK/memory.json" \
    '[primary(d, "remember", env["PREFIX"] + "-memory-" + a) for a in ("off", "on")] == ["failed", "passed"]' \
    '"off {} · on {}".format(primary(d, "remember", env["PREFIX"] + "-memory-off"), primary(d, "remember", env["PREFIX"] + "-memory-on"))'
  for ARM in off on; do
    RUN="$(run_of "$WORK/memory.json" currency "$PREFIX-memory-$ARM")"
    if need "  currency, memory $ARM: the seed, one model call" "$RUN"; then
      request GET "/runs/$RUN"
      # Phase 8 G9: the seed is copied in only with memory on; with memory off the record lists it as skipped.
      ARM="$ARM" check "  currency, memory $ARM: seed $([ "$ARM" = on ] && echo 'copied in' || echo 'left out'), background review 10/10, 1 model call" 200 \
        '([s["path"] for s in d["launchRecord"]["homeSeeds"]], d["launchRecord"]["homeMemory"]) == ((["memories/USER.md"], {"memoryEnabled": True, "seedsSkipped": [], "memoriesCollected": True}) if env["ARM"] == "on" else ([], {"memoryEnabled": False, "seedsSkipped": ["memories/USER.md"], "memoriesCollected": False})) and d["launchRecord"]["backgroundReview"] == {"memoryNudgeInterval": 10, "skillCreationNudgeInterval": 10} and "nudge_interval: 10" in d["launchRecord"]["configYaml"] and calls(d) == 1' \
        '"seeds {} · skipped {} · {} model calls".format([s["path"] for s in d["launchRecord"]["homeSeeds"]], (d["launchRecord"]["homeMemory"] or {}).get("seedsSkipped"), calls(d))'
      # The memory toolset comes with memory on alone, in the command and config.yaml alike.
      WANT_T="$([ "$ARM" = on ] && echo 'file,memory,terminal' || echo 'file,terminal')" \
        check "  currency, memory $ARM: the launch record's -t list" 200 \
        '" -t {} ".format(env["WANT_T"]) in d["launchRecord"]["command"] and ("- memory" in d["launchRecord"]["configYaml"]) == ("memory," in env["WANT_T"])' \
        '"-t " + d["launchRecord"]["command"].split(" -t ")[1].split(" ")[0]'
    fi
  done
  RUN="$(run_of "$WORK/memory.json" remember "$PREFIX-memory-on")"
  if need '  remember, memory on: USER.md collected from the home' "$RUN"; then
    request GET "/runs/$RUN"
    check '  remember, memory on: USER.md modified, root home, scored; 2 model calls' 200 \
      'any(a["root"] == "home" and a["path"] == "home/memories/USER.md" and a["origin"] == "home_seed_modified" for a in d["artifacts"]["items"]) and sc(d, "saved")["status"] == "passed" and sc(d, "used_memory")["status"] == "passed" and calls(d) == 2' \
      '"; ".join("{path} {origin}".format_map(a) for a in d["artifacts"]["items"] if a["root"] == "home") + " · {} model calls (a background review would add some)".format(calls(d))'
  fi
  RUN="$(run_of "$WORK/memory.json" remember "$PREFIX-memory-off")"
  if need '  remember, memory off: nothing in the home' "$RUN"; then
    request GET "/runs/$RUN"
    check '  remember, memory off: no memory tool, no seed, nothing collected from the home' 200 \
      'not any(a["root"] == "home" for a in d["artifacts"]["items"]) and d["launchRecord"]["homeMemory"]["memoriesCollected"] is False and sc(d, "saved")["status"] == "failed" and sc(d, "used_memory")["status"] == "failed"' \
      '"; ".join("{path} {origin}".format_map(a) for a in d["artifacts"]["items"] if a["root"] == "home") or "no home artifact"'
  fi
  if [ "$DOCKER" = 1 ]; then
    # Egress's own connection log, as the worker stored it: every model call
    # of the attempt, each marked whether Hermes made it in the background.
    RUN="$(run_of "$WORK/memory.json" remember "$PREFIX-memory-on")"
    CALLS="$(psql_ro "select count(*) || ' ' || count(*) filter (where (e.payload->>'background')::boolean) from run_events e join attempts a on a.id = e.attempt_id where a.run_id = '$RUN' and e.payload->>'subtype' = 'network' and e.payload->>'kind' = 'model'")"
    if [ "$CALLS" = '2 0' ]; then
      pass "  egress's connection log of remember, memory on: 2 model calls, none background" 'no background review fork (S3: one-shot runs are finite turns)'
    else
      fail "  egress's connection log of remember, memory on: 2 model calls, none background" "model calls, background ones: ${CALLS:-unreadable}"
    fi
    if mock_requests "$WORK/mock.json"; then
      check_file '  the mock saw the seed in the system prompt only with memory on' "$WORK/mock.json" \
        '[(x["script"], "smoke-phase6-seed" in x["body"]["messages"][0]["content"] and "USER PROFILE" in x["body"]["messages"][0]["content"]) for x in d[int(env["MOCK_FROM"]):] if x["script"] in ("smoke-phase6-seed the user reports in NOK", "smoke-phase6-currency")] in ([("smoke-phase6-seed the user reports in NOK", True), ("smoke-phase6-currency", False)], [("smoke-phase6-currency", False), ("smoke-phase6-seed the user reports in NOK", True)])' \
        '"currency requests: " + ", ".join(x["script"] for x in d[int(env["MOCK_FROM"]):] if x["script"].startswith(("smoke-phase6-seed", "smoke-phase6-currency")))'
    else
      fail '  the mock saw the seed in the system prompt only with memory on' 'could not read the mock log'
    fi
  fi
fi

# ---------------------------------------------------------------------------
section 'vendor-directory (P4): only through egress, which adds the header'
# ---------------------------------------------------------------------------

if [ "$TOKEN_SET" != true ]; then
  skip 'vendors experiment' 'VENDOR_DIRECTORY_TOKEN is not set in egress: the launch 409 above stands in'
elif need 'vendors experiment' "$VENDORS_EXP" && settles 'vendors' "$VENDORS_EXP" 2 "$WORK/vendors.json"; then
  check_file 'vendors: the on-hold vendors only through MCP' "$WORK/vendors.json" \
    '[primary(d, "vendors", env["PREFIX"] + "-" + a) for a in ("baseline", "with-vendors")] == ["failed", "passed"]' \
    '"baseline {} · with-vendors {}".format(primary(d, "vendors", env["PREFIX"] + "-baseline"), primary(d, "vendors", env["PREFIX"] + "-with-vendors"))'
  RUN="$(run_of "$WORK/vendors.json" vendors "$PREFIX-with-vendors")"
  if need '  with-vendors: the gateway call, the trial cannot reach the server' "$RUN"; then
    request GET "/runs/$RUN"
    check '  with-vendors: list_vendors through /mcp/vendor-directory, 200' 200 \
      'sc(d, "through_mcp")["status"] == "passed" and any(e["kind"] == "network" and e["network"]["kind"] == "mcp" and e["network"]["server"] == "vendor-directory" and e["network"]["status"] == 200 for e in d["timeline"]["events"])' \
      '", ".join(sorted({"{}:{}".format(e["network"]["kind"], e["network"]["status"]) for e in d["timeline"]["events"] if e["kind"] == "network"}))'
    check '  with-vendors: get_vendor answered the probe with its not-found reply' 200 \
      'any(e["kind"] == "tool" and e["title"] == "get_vendor" and env["VENDOR_REPLY"] in (e["output"] or "") for e in d["timeline"]["events"])' \
      'next(" ".join((e["output"] or "").split())[-120:] for e in d["timeline"]["events"] if e["kind"] == "tool" and e["title"] == "get_vendor")'
    check '  the trial reaches vendor-directory neither directly nor through the proxy' 200 \
      'any("REACH_DONE" in (e["output"] or "") and "direct=" in e["output"] and "=401" not in e["output"] and "=405" not in e["output"] and "=200" not in e["output"] for e in d["timeline"]["events"] if e["kind"] == "tool")' \
      '" ".join(next(e["output"] for e in d["timeline"]["events"] if e["kind"] == "tool" and "REACH_DONE" in (e["output"] or "")).split())'
    # The trial's only Authorization is its own attempt token for egress, by
    # reference (the launch record shows a reference as <from env NAME>).
    check '  config.yaml points at egress; no header value but the attempt token reference' 200 \
      '"http://egress:8080/mcp/vendor-directory" in d["launchRecord"]["configYaml"] and [l.strip() for l in d["launchRecord"]["configYaml"].splitlines() if "Authorization" in l] == ["Authorization: Bearer <from env HERMES_EVALS_ATTEMPT_TOKEN>"] and "VENDOR_DIRECTORY_TOKEN" not in d["launchRecord"]["configYaml"]' \
      'next(s["definition"] for s in d["launchRecord"]["container"]["mcpServers"] if s["name"] == "vendor-directory").replace("\n", " ")'
  fi
fi

# ---------------------------------------------------------------------------
section 'invoice-db (P4): 20 invoices a page, and a cursor to the next'
# ---------------------------------------------------------------------------

if [ "$INVOICE_DB_SET" != true ]; then
  skip 'ledger experiment' 'the worker lacks INVOICE_DB_URL: the launch 409 above stands in'
elif need 'ledger experiment' "$LEDGER_EXP" && settles 'ledger' "$LEDGER_EXP" 2 "$WORK/ledger.json"; then
  check_file 'ledger: the second page only through invoice-db' "$WORK/ledger.json" \
    '[primary(d, "ledger", env["PREFIX"] + "-" + a) for a in ("baseline", "with-ledger")] == ["failed", "passed"]' \
    '"baseline {} · with-ledger {}".format(primary(d, "ledger", env["PREFIX"] + "-baseline"), primary(d, "ledger", env["PREFIX"] + "-with-ledger"))'
  RUN="$(run_of "$WORK/ledger.json" ledger "$PREFIX-with-ledger")"
  if need '  with-ledger: two list_invoices calls' "$RUN"; then
    request GET "/runs/$RUN"
    check '  with-ledger: list_invoices twice on invoice-db, the second with the cursor' 200 \
      '[(e["server"], json.loads(e["input"] or "{}").get("cursor")) for e in d["timeline"]["events"] if e["kind"] == "tool" and e["title"] == "list_invoices"] == [("invoice-db", None), ("invoice-db", env["CURSOR2"])] and sc(d, "paged")["status"] == "passed"' \
      '"; ".join("{} {} chars{}".format(e["title"], e["outputChars"], " (the timeline keeps 5,000)" if e["truncated"] else "") for e in d["timeline"]["events"] if e["kind"] == "tool")'
    check '  with-ledger: get_invoice answered the probe with its not-found reply' 200 \
      'any(e["kind"] == "tool" and e["title"] == "get_invoice" and env["LEDGER_REPLY"] in (e["output"] or "") for e in d["timeline"]["events"])' \
      'next(" ".join((e["output"] or "").split())[-120:] for e in d["timeline"]["events"] if e["kind"] == "tool" and e["title"] == "get_invoice")'
    # A stdio server's values reach it from the worker's environment, by name.
    check '  config.yaml: invoice-db started in the trial, INVOICE_DB_URL by reference' 200 \
      '"command: invoice-db-mcp" in d["launchRecord"]["configYaml"] and "INVOICE_DB_URL: <from env INVOICE_DB_URL>" in d["launchRecord"]["configYaml"] and "file:///" not in d["launchRecord"]["configYaml"]' \
      'next(s["definition"] for s in d["launchRecord"]["container"]["mcpServers"] if s["name"] == "invoice-db").replace("\n", " ")'
  fi
  if [ "$DOCKER" = 1 ] && mock_requests "$WORK/mock.json"; then
    # The model's last request, the one the probe's reply answered, holds
    # both pages as Hermes handed them over (beside the terminal's and the
    # probe's results).
    check_file '  the pages as the model got them: 20 + 20 invoices, the next cursors' "$WORK/mock.json" \
      '[([i["invoice_no"] for i in p["invoices"]], p["next_cursor"]) for p in [mcp_result(m["content"]) for m in [x for x in d[int(env["MOCK_FROM"]):] if x["script"] == env["LEDGER_REPLY"]][-1]["body"]["messages"] if m["role"] == "tool" and "{\"result\"" in m["content"]]] == [(["INV-{}".format(1001 + i) for i in range(20)], env["CURSOR2"]), (["INV-{}".format(1021 + i) for i in range(20)], env["CURSOR3"])]' \
      '" · ".join("{} invoices {}..{}, next_cursor {}".format(len(p["invoices"]), p["invoices"][0]["invoice_no"], p["invoices"][-1]["invoice_no"], p["next_cursor"]) for p in [mcp_result(m["content"]) for m in [x for x in d[int(env["MOCK_FROM"]):] if x["script"] == env["LEDGER_REPLY"]][-1]["body"]["messages"] if m["role"] == "tool" and "{\"result\"" in m["content"]])'
  elif [ "$DOCKER" = 1 ]; then
    fail '  the pages as the model got them' 'could not read the mock log'
  fi
fi

# ---------------------------------------------------------------------------
section 'An http header variable egress lacks (S7): egress recreated without VENDOR_DIRECTORY_TOKEN'
# ---------------------------------------------------------------------------

# Only when egress's token is the one Compose gives it from this shell and
# .env (compared by hash), so recreating egress puts it back as it was, and
# when no trial is running, since every trial's traffic goes through egress.
if [ "$SMOKE_RESTART" != 1 ]; then
  skip 'egress without VENDOR_DIRECTORY_TOKEN' 'opt-in, it recreates egress: run with SMOKE_RESTART=1 (and the docker checks) to include it'
elif [ "$DOCKER" = 1 ] && [ "$TOKEN_SET" = true ]; then
  read -r RUNNING_HASH COMPOSED_HASH <<<"$(token_hashes)"
  request GET /system/workers
  BUSY="$(jv 'sum(w["slotsInUse"] for w in d if w["status"] == "online")' 2>/dev/null || echo '?')"
  if ! need 'egress without VENDOR_DIRECTORY_TOKEN' "$SUITE_ID" "$BASELINE" "$WITH_VENDORS" "$VENDORS_ID"; then
    :
  elif [ "$RUNNING_HASH" = none ] || [ "$RUNNING_HASH" != "$COMPOSED_HASH" ]; then
    skip 'egress without VENDOR_DIRECTORY_TOKEN' 'egress holds another token than this shell and .env give Compose: export the one it started with'
  elif [ "$BUSY" != 0 ]; then
    skip 'egress without VENDOR_DIRECTORY_TOKEN' "$BUSY trial slots in use: egress carries their traffic"
  else
    EGRESS_CHANGED=1
    if egress_up '' && token_seen false; then
      pass 'egress recreated without VENDOR_DIRECTORY_TOKEN; the worker reports it unset' 'VENDOR_DIRECTORY_TOKEN= docker compose up -d --no-deps egress'
      request GET /experiments/new-options
      check '  New experiment: with-vendors names VENDOR_DIRECTORY_TOKEN (http)' 200 \
        'next(c for c in d["configurations"] if c["versionId"] == env["WITH_VENDORS"])["missingSecrets"] == [{"server": "vendor-directory", "name": "VENDOR_DIRECTORY_TOKEN", "transport": "http"}]' \
        'json.dumps(next(c for c in d["configurations"] if c["versionId"] == env["WITH_VENDORS"])["missingSecrets"])'
      launch "$SUITE_ID" "$PREFIX-vendors-409" vendors "$BASELINE" "$WITH_VENDORS"
      check '  launch with-vendors -> 409 naming VENDOR_DIRECTORY_TOKEN, added by egress' 409 \
        'd["message"].startswith("{}-with-vendors: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set. ".format(env["PREFIX"])) and d["issues"] == [{"path": "candidateVersionIds.0", "message": "VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)"}]' \
        'd["message"]'
      send_json POST "/resources/mcp-servers/$VENDORS_ID/test"
      check '  Test start vendor-directory -> failed, the variable named' 200 \
        'd["status"] == "failed" and d["missingSecretNames"] == ["VENDOR_DIRECTORY_TOKEN"]' 'd["error"]'
    else
      fail 'egress recreated without VENDOR_DIRECTORY_TOKEN; the worker reports it unset' "$(tail -3 "$WORK/compose.log" | tr '\n' ' ')"
    fi
    if egress_up && token_seen true; then
      read -r RUNNING_HASH COMPOSED_HASH <<<"$(token_hashes)"
      if [ "$RUNNING_HASH" = "$COMPOSED_HASH" ]; then
        EGRESS_CHANGED=0
        send_json POST "/resources/mcp-servers/$VENDORS_ID/test"
        check 'egress put back with its token (same hash): Test start passes again' 200 \
          'd["status"] == "passed"' '"{} in {} ms".format(d["status"], d["startedMs"])'
      else
        fail 'egress put back with its token (same hash)' 'the token egress holds now differs from the one it had'
      fi
    else
      fail 'egress put back with its token' "$(tail -3 "$WORK/compose.log" | tr '\n' ' ')"
    fi
  fi
elif [ "$TOKEN_SET" != true ]; then
  skip 'egress without VENDOR_DIRECTORY_TOKEN' 'egress has no token to take away (the vendors 409 above stands in)'
else
  skip 'egress without VENDOR_DIRECTORY_TOKEN' 'needs the docker checks (SMOKE_RESTART=1 is set)'
fi

# ---------------------------------------------------------------------------
section 'Cleanup'
# ---------------------------------------------------------------------------

rm -rf "$SUITE_DIR"
send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
check 'remove the suite directory and reload -> missing' 200 \
  'd["suites"][0]["outcome"] == "missing"' '"{outcome}: {message} (its suite_sources row stays)".format_map(d["suites"][0])'

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILS" "$SKIPS"
[ "$FAILS" -eq 0 ]
