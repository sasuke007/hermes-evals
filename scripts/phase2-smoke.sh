#!/usr/bin/env bash
# Phase 2 smoke test: runs real experiments on a running Hermes Evals stack,
# in real trial containers, with real Hermes against the scripted mock model,
# and prints one PASS/FAIL/SKIP line per step. It covers what Phase 2 adds:
# a temporary suite (three small tasks and a slow one), a skill, two
# configurations, the estimate, a launch of 3 tasks x 2 configurations x 2
# repetitions followed live (GET /experiments/:id/events), the results (the
# baseline fails `total`, the configuration with the skill passes it, the
# rest pass), the read APIs (experiment list and detail, the runs list and
# its filters, the run inspector, events paging, the artifact download),
# then pause and resume, and cancel.
#
#   scripts/phase2-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase2-smoke.sh  # through nginx
#
# The stack needs the mock model (profile `test`) with the scripts in
# scripts/phase2-mock-scripts.json, which answer each task's prompt (they
# match "Smoke task TOTAL", "Smoke task LIST", ... and the skill's phrase).
# Compose reads MOCK_SCRIPTS from the shell before .env, so no file changes:
#
#   MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase2-mock-scripts.json"))))')" \
#     docker compose --profile test up -d
#
# (only mock-model reads it, so on a running stack `... up -d mock-model` is
# enough). The same override as a file, for `docker compose -f
# docker-compose.yml -f <file> --profile test up -d`:
#
#   services:
#     mock-model:
#       environment:
#         MOCK_SCRIPTS: '<the JSON of scripts/phase2-mock-scripts.json, on one line>'
#
# Every configuration uses provider `custom` with base URL
# http://mock-model:8090/v1 and model mock/scripted, which config/prices.yaml
# prices at 0: no real provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl and python3. Exits 0 only when no step
# failed. It writes to the stack it tests, so point it at a development stack
# only. Every name it creates starts with smoke-<UTC timestamp> (the suite
# directory zz-smoke-exec-<timestamp>), so it can run again and again. The
# suite directory is removed at the end and reloaded, which leaves its
# suite_sources row in state `missing`; the experiments, configurations and
# skill stay (there are no delete endpoints).
#
# Settings (environment):
#   BASE_URL       API base URL (default http://localhost:3000/api)
#   SUITES_DIR     host directory the worker reads suites from (default <repo>/suites)
#   SMOKE_DOCKER   auto (default) | 0: also check, read-only through `docker compose`,
#                  that the mock has the scripts, that no trial container or egress
#                  registration is left, that homes are deleted and workspaces kept,
#                  and the raw run_events and launch records
#   RUN_TIMEOUT    seconds an experiment may take to finish (default 300)
#   CURL_TIMEOUT   seconds per request (default 120)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
RUN_TIMEOUT="${RUN_TIMEOUT:-300}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
SUITE_NAME="zz-smoke-exec-$STAMP"
SUITE_DIR="$SUITES_DIR/$SUITE_NAME"
BASELINE_NAME="$PREFIX-baseline"
SKILL_CFG_NAME="$PREFIX-with-skill"
SKILL_NAME="$PREFIX-due-method"
# The phrase the mock matches in the system prompt: Hermes preloads `-s` skills
# into it whole (hermes_cli/oneshot.py, agent/skill_commands.py).
SKILL_PHRASE='smoke-due-method: count only rows whose status is open'
export PREFIX SUITE_NAME BASELINE_NAME SKILL_CFG_NAME SKILL_NAME

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "phase2-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase2-smoke.XXXXXX")"
BODY="$WORK/body"
HEADERS="$WORK/headers"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
SSE_PID=''

# ---------------------------------------------------------------------------
# Helpers (as in phase1-smoke.sh)
# ---------------------------------------------------------------------------

# request METHOD PATH [curl args...]: the body lands in $BODY, the headers in
# $HEADERS and the status in $STATUS (000 when curl itself failed, with its
# error as the body). State-changing requests carry X-Requested-With.
request() {
  local method="$1" path="$2"
  shift 2
  : >"$HEADERS"
  if [ "$method" = GET ]; then
    STATUS="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
  else
    STATUS="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      -X "$method" -H 'X-Requested-With: phase2-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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
# response) as `d`, with `env`, `json` and `raw`. A string prints as it is,
# anything else as JSON. str.format, not f-strings (Python before 3.12).
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

line() { printf '%-5s %-62s %s\n' "$1" "$2" "$3"; }
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

# wait_for PATH EXPR TIMEOUT: polls GET PATH every second until EXPR is true
# over its body; returns 1 on timeout. The last response stays in $BODY.
wait_for() {
  local path="$1" expr="$2" timeout="$3" start
  start="$(date +%s)"
  while :; do
    request GET "$path"
    if [ "$STATUS" = 200 ] && [ "$(jv "$expr" 2>/dev/null)" = true ]; then return 0; fi
    [ $(($(date +%s) - start)) -ge "$timeout" ] && return 1
    sleep 1
  done
}

# launch NAME TASKS REPETITIONS CONCURRENCY: POST /experiments for the two
# configurations on the temporary suite; the id lands in $EXP (empty on failure).
launch() {
  local body
  body="$(python3 - "$WORK/options.json" "$1" "$2" "$3" "$4" <<'PY'
import json, os, sys
options, name, tasks, reps, conc = sys.argv[1:6]
o = json.load(open(options))
h = {c['versionId']: c['configHash'] for c in o['configurations']}
b, c = os.environ['BASELINE_VERSION_ID'], os.environ['SKILL_VERSION_ID']
print(json.dumps({'name': name, 'description': 'phase2-smoke: ' + name, 'suiteId': os.environ['SUITE_ID'],
                  'taskKeys': tasks.split(','), 'baselineVersionId': b, 'candidateVersionIds': [c],
                  'repetitions': int(reps), 'concurrency': int(conc), 'spendCeilingUsd': None,
                  'timeBudgetOverrideS': None, 'expectedConfigHashes': {b: h[b], c: h[c]}}))
PY
  )"
  send_json POST /experiments "$body"
  EXP=''
  [ "$STATUS" = 201 ] && EXP="$(jv 'd["id"]' 2>/dev/null)"
  return 0
}

# Docker checks run when the stack is this repository's Compose project here.
DOCKER=0
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null &&
  (cd "$REPO_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx worker); then
  DOCKER=1
fi
dc() { (cd "$REPO_DIR" && docker compose "$@"); }
psql_ro() { dc exec -T postgres psql -U hermes -d hermes_evals -At -c "$1" 2>/dev/null; }
egress_attempts() {
  dc exec -T egress node -e "require('http').get({socketPath:'/run/egress/admin.sock',path:'/health'},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.parse(b).attempts))})" 2>/dev/null
}

# Removes the temporary suite directory (and reloads it, so it is `missing`),
# stops a background SSE reader, then the work directory.
cleanup() {
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null
  if [ -d "$SUITE_DIR" ]; then
    rm -rf "$SUITE_DIR"
    send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'Phase 2 smoke · %s · stamp %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

# ---------------------------------------------------------------------------
section 'Stack'
# ---------------------------------------------------------------------------

request GET /health
check 'GET /health' 200 \
  'd["status"] == "ok" and all(v == "ok" for v in d["checks"].values())' \
  '"status " + d["status"] + " · " + ", ".join(k + " " + v for k, v in d["checks"].items())'

request GET /system/sandbox
check 'GET /system/sandbox: isolation proven' 200 \
  'd["proven"] and all(c["passed"] for c in d["checks"])' \
  '"{}/{} checks · {}".format(sum(c["passed"] for c in d["checks"]), len(d["checks"]), d["revision"])'

request GET /system/workers
check 'GET /system/workers: a worker online' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] for w in d)' \
  '"; ".join("{} concurrency {} slots {}/{}".format(w["id"], w["concurrency"], w["slotsInUse"], w["slotsTotal"]) for w in d if w["status"] == "online")'

request GET /providers
check 'GET /providers' 200 \
  'isinstance(d, list) and {"nous", "openrouter"} <= {p["id"] for p in d} and all(p["status"] for p in d)' \
  '", ".join("{} {}".format(p["id"], p["status"]) for p in d)'

if [ "$DOCKER" = 1 ]; then
  if dc exec -T mock-model printenv MOCK_SCRIPTS 2>/dev/null | grep -q 'Smoke task LIST'; then
    pass 'the mock model has scripts/phase2-mock-scripts.json' 'MOCK_SCRIPTS matches "Smoke task LIST", ...'
  else
    fail 'the mock model has scripts/phase2-mock-scripts.json' 'start it as the header says (profile test, MOCK_SCRIPTS)'
  fi
else
  skip 'the mock model has scripts/phase2-mock-scripts.json' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section "Suite (temporary directory suites/$SUITE_NAME)"
# ---------------------------------------------------------------------------

python3 - "$SUITE_DIR" "$SUITE_NAME" <<'PY'
import os, sys
root, name = sys.argv[1], sys.argv[2]
def put(path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(text)
put('suite.yaml', "name: {}\nversion_label: '0.1'\ndescription: Temporary Phase 2 smoke suite, run against the scripted mock model.\n"
    "tasks: [total, list, report, slow]\n".format(name))
fenced = '\n\nEnd your reply with a fenced JSON block:\n\n```json\n{}\n```\n'
limits = 'limits:\n  max_turns: 10\n  run_budget_seconds: {}\n  toolsets_needed: [{}]\n'
put('total/task.yaml', 'summary: Total amount still due in amounts.csv\n' + limits.format(120, 'terminal') +
    'answer:\n  format: fenced_json\n  path: total\nverification:\n  - key: answer\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n')
put('total/prompt.md', 'Smoke task TOTAL. Add up the `amount` of the rows of `amounts.csv` that are still due.' + fenced.format('{ "total": 0.0 }'))
put('total/fixtures/amounts.csv', 'id,amount,status\nA1,100.00,open\nA2,250.50,paid\nA3,40.25,open\nA4,9.25,open\n')
put('total/reference.json', '{ "total": 149.50 }\n')
put('list/task.yaml', 'summary: The open ids in items.csv\n' + limits.format(120, 'terminal') +
    'answer:\n  format: fenced_json\nverification:\n  - key: answer\n    type: json_match\n    primary: true\n    params: { path: ids, unordered: true }\n')
put('list/prompt.md', 'Smoke task LIST. Which ids in `items.csv` are open?' + fenced.format('{ "ids": [] }'))
put('list/fixtures/items.csv', 'id,state\nb,open\nx,closed\na,open\nc,open\n')
put('list/reference.json', '{ "ids": ["a", "b", "c"] }\n')
put('report/task.yaml', 'summary: Write report.csv with one row per vendor\n' + limits.format(120, 'file, terminal') +
    'answer:\n  format: fenced_json\nverification:\n  - key: report_csv\n    type: file_check\n    primary: true\n'
    '    params:\n      path: report.csv\n      format: csv\n      columns: [vendor, total]\n      row_count: 2\n'
    'self_check:\n  expected_workspace: expected\n')
put('report/prompt.md', 'Smoke task REPORT. Read `invoices.csv` and write `report.csv` with the columns vendor,total, one row per vendor.' + fenced.format('{ "done": true }'))
put('report/fixtures/invoices.csv', 'vendor,amount\nAcme,10.00\nBorealis,5.50\nAcme,2.00\n')
put('report/expected/report.csv', 'vendor,total\nAcme,12.00\nBorealis,5.50\n')
put('report/reference.json', '{ "done": true }\n')
put('slow/task.yaml', 'summary: The number of rows in rows.csv, after a slow check\n' + limits.format(180, 'terminal') +
    'answer:\n  format: fenced_json\n  path: rows\nverification:\n  - key: answer\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0 }\n')
put('slow/prompt.md', 'Smoke task SLOW. Count the data rows of `rows.csv` (not the header).' + fenced.format('{ "rows": 0 }'))
put('slow/fixtures/rows.csv', 'id\n1\n2\n3\n')
put('slow/reference.json', '{ "rows": 3 }\n')
PY

send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
check 'reload the new directory -> created v1' 200 \
  'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1' \
  '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
SUITE_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"
export SUITE_ID

if need 'suite detail: 4 valid tasks, self-checks passed' "$SUITE_ID"; then
  request GET "/suites/$SUITE_ID"
  check 'suite detail: 4 valid tasks, self-checks passed' 200 \
    'd["validCount"] == d["taskCount"] == 4 and sorted(t["key"] for t in d["tasks"]) == ["list", "report", "slow", "total"]' \
    '", ".join("{} v{} {}".format(t["key"], t["version"], "valid" if t["valid"] else "INVALID") for t in d["tasks"])'
fi

# ---------------------------------------------------------------------------
section 'Skill and configurations'
# ---------------------------------------------------------------------------

SKILL_ZIP="$WORK/$SKILL_NAME.zip"
python3 - "$SKILL_ZIP" "$SKILL_NAME" "$SKILL_PHRASE" <<'PY'
import sys, zipfile
path, name, phrase = sys.argv[1:4]
md = '---\nname: {}\nversion: 1.0.0\ndescription: Smoke-test skill. How to total the amounts that are still due.\n---\n\n# Due method\n\n{}. Paid rows are never due.\n'.format(name, phrase)
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(name + '/SKILL.md', md)
PY
request POST /resources/skills/validate -F "file=@$SKILL_ZIP;type=application/zip"
check 'POST /resources/skills/validate' 200 \
  'd["outcome"] == "valid" and d["name"] == env["SKILL_NAME"]' '"{outcome} · {name}@{version}".format_map(d)'
SKILL_TOKEN="$(jv 'd["token"]' 2>/dev/null)"
SKILL_ID=''
if need 'POST /resources/skills (confirm)' "$SKILL_TOKEN"; then
  send_json POST /resources/skills "{\"token\":\"$SKILL_TOKEN\"}"
  check 'POST /resources/skills (confirm)' 201 'd["name"] == env["SKILL_NAME"]' '"{name}@{version} #{contentHash:.7}".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
fi

config_body() {
  printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":["file","terminal"],"memoryEnabled":false,"skillIds":[%s],"documentIds":[],"mcpServerVersionIds":[],"maxTurns":10,"timeBudgetS":120,"duplicatedFromVersionId":null}' "$1" "$2"
}
send_json POST /configurations "$(config_body "$BASELINE_NAME" '')"
check "POST /configurations $BASELINE_NAME (custom, mock)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)'
BASELINE_VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
SKILL_VERSION_ID=''
if need "POST /configurations $SKILL_CFG_NAME" "$SKILL_ID"; then
  send_json POST /configurations "$(config_body "$SKILL_CFG_NAME" "\"$SKILL_ID\"")"
  check "POST /configurations $SKILL_CFG_NAME (custom, mock, the skill)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)'
  SKILL_VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
fi
export BASELINE_VERSION_ID SKILL_VERSION_ID

CONCURRENCY=3
if need 'GET /experiments/new-options' "$SUITE_ID" "$BASELINE_VERSION_ID" "$SKILL_VERSION_ID"; then
  request GET /experiments/new-options
  check 'GET /experiments/new-options' 200 \
    'any(s["suiteId"] == env["SUITE_ID"] and sum(t["valid"] for t in s["tasks"]) == 4 for s in d["suites"]) and {env["BASELINE_VERSION_ID"], env["SKILL_VERSION_ID"]} <= {c["versionId"] for c in d["configurations"]} and d["maxConcurrency"] >= 1' \
    '"max concurrency {} · {} workers · prices: {}".format(d["maxConcurrency"], d["workerCount"], ", ".join("{model} {inputPer1M}/{outputPer1M}".format_map(p) for p in d["priceTable"]))'
  cp "$BODY" "$WORK/options.json"
  CONCURRENCY="$(jv 'min(3, d["maxConcurrency"]) or 1' 2>/dev/null || echo 3)"
  request GET "/experiments/estimate?suite=$SUITE_ID&versions=$BASELINE_VERSION_ID,$SKILL_VERSION_ID&tasks=3&repetitions=2&concurrency=$CONCURRENCY"
  check 'GET /experiments/estimate (3 tasks x 2 x 2)' 200 \
    'd["runs"] == 12 and d["costUsd"] == 0' '"{runs} runs · {waves} waves · {durationS} s · ${costUsd} · basis {basis}".format_map(d)'
fi

# ---------------------------------------------------------------------------
section 'Experiment: 3 tasks x 2 configurations x 2 repetitions'
# ---------------------------------------------------------------------------

EXP=''
export CONCURRENCY
if need 'POST /experiments (launch)' "$SUITE_ID" "$BASELINE_VERSION_ID" "$SKILL_VERSION_ID"; then
  launch "$PREFIX-exec" total,list,report 2 "$CONCURRENCY"
  check 'POST /experiments (launch)' 201 'bool(d["id"])' '"experiment " + d["id"] + " · concurrency " + env.get("CONCURRENCY", "?")'
fi
MAIN_EXP="$EXP"
export MAIN_EXP

if need 'experiment completes' "$MAIN_EXP"; then
  curl -sN --max-time "$RUN_TIMEOUT" "$BASE_URL/experiments/$MAIN_EXP/events" >"$WORK/sse.txt" 2>/dev/null &
  SSE_PID=$!
  if wait_for "/experiments/$MAIN_EXP" 'd["status"] in ("completed", "failed")' "$RUN_TIMEOUT"; then
    check 'experiment completes, 12 of 12 runs scored' 200 \
      'd["status"] == "completed" and d["counts"]["scored"] == 12' \
      '"{} in {} s · ".format(d["status"], d["elapsedS"]) + ", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)'
  else
    fail 'experiment completes, 12 of 12 runs scored' "still $(jv 'd["status"] + " " + json.dumps({k: v for k, v in d["counts"].items() if v})' 2>/dev/null) after ${RUN_TIMEOUT} s"
  fi
  cp "$BODY" "$WORK/detail.json"
  sleep 2
  kill "$SSE_PID" 2>/dev/null
  wait "$SSE_PID" 2>/dev/null
  SSE_PID=''
  python3 - "$WORK/sse.txt" >"$WORK/sse.json" <<'PY'
import json, sys
events, name = [], None
for raw in open(sys.argv[1], encoding='utf-8', errors='replace'):
    raw = raw.rstrip('\n')
    if raw.startswith('event: '):
        name = raw[7:]
    elif raw.startswith('data: '):
        events.append({'event': name, 'data': json.loads(raw[6:])})
print(json.dumps(events))
PY
  cp "$WORK/sse.json" "$BODY"
  STATUS=200
  check 'GET /experiments/:id/events (SSE, followed live)' 200 \
    'd[0]["event"] == "experiment" and {"run", "feed", "counts", "experiment"} <= {e["event"] for e in d} and d[-1]["event"] == "experiment" and d[-1]["data"]["status"] == "completed" and all(e["event"] == e["data"]["type"] for e in d)' \
    '"{} events: ".format(len(d)) + ", ".join("{} {}".format(sum(1 for e in d if e["event"] == k), k) for k in ("experiment", "counts", "run", "feed")) + " · last: experiment " + d[-1]["data"]["status"]'

  request GET "/experiments/$MAIN_EXP/runs"
  cp "$BODY" "$WORK/runs.json"
  check 'baseline fails total, with-skill passes it, the rest pass' 200 \
    'sorted((r["taskKey"], r["configuration"]["name"] == env["SKILL_CFG_NAME"], (r["primaryScore"] or {}).get("status")) for r in d["rows"]) == sorted([(t, s, "failed" if (t == "total" and not s) else "passed") for t in ("total", "list", "report") for s in (False, True) for _ in (1, 2)])' \
    '", ".join("{}/{}={}".format(t, c, sum(1 for r in d["rows"] if r["taskKey"] == t and (r["configuration"]["name"] == env["SKILL_CFG_NAME"]) == (c == "skill") and r["primaryScore"]["status"] == "passed")) for t in ("total", "list", "report") for c in ("base", "skill")) + " passed of 2"'
  check 'tokens recorded on every run; cost 0 (mock/scripted)' 200 \
    'all(r["tokens"] and r["tokens"]["total"] > 0 and r["costUsd"] == 0 for r in d["rows"])' \
    '"tokens {}..{} per run · cost {}".format(min(r["tokens"]["total"] for r in d["rows"]), max(r["tokens"]["total"] for r in d["rows"]), sorted({r["costUsd"] for r in d["rows"]}))'
  FAILED_RUN="$(jv 'next(r["id"] for r in d["rows"] if r["taskKey"] == "total" and r["configuration"]["name"] == env["BASELINE_NAME"])' 2>/dev/null)"
  PASSED_RUN="$(jv 'next(r["id"] for r in d["rows"] if r["taskKey"] == "report" and r["configuration"]["name"] == env["SKILL_CFG_NAME"])' 2>/dev/null)"
  export FAILED_RUN PASSED_RUN

  cp "$WORK/detail.json" "$BODY"
  STATUS=200
  check 'GET /experiments/:id: aggregates, spend, feed' 200 \
    'abs(next(a for a in d["aggregates"] if a["configuration"]["name"] == env["BASELINE_NAME"])["passRate"] - 4 / 6) < 0.001 and next(a for a in d["aggregates"] if a["configuration"]["name"] == env["SKILL_CFG_NAME"])["passRate"] == 1 and d["spend"]["spentUsd"] == 0 and d["spend"]["unpricedAttempts"] == 0 and len(d["feed"]) == 10 and d["verdicts"] == [] and d["failure"] is None' \
    '"; ".join("{} pass {} median {} s tokens {}".format(a["configuration"]["name"][len(env["PREFIX"]) + 1:], a["passRate"], a["medianDurationS"], a["meanTokens"]) for a in d["aggregates"]) + " · spend ${spentUsd}".format_map(d["spend"])'

  request GET /experiments
  check 'GET /experiments lists it: done 12, cost 0' 200 \
    'any(r["id"] == env["MAIN_EXP"] and r["status"] == "completed" and r["doneRuns"] == 12 and r["costUsd"] == 0 for r in d)' \
    '"{} experiments".format(len(d))'

  request GET "/experiments/$MAIN_EXP/runs?config=$BASELINE_NAME&task=total"
  check 'runs filter config=baseline&task=total -> 2 failed' 200 \
    'd["matched"] == 2 and all(r["primaryScore"]["status"] == "failed" for r in d["rows"]) and d["summary"]["total"] == 12' \
    '"matched {} · summary {}".format(d["matched"], json.dumps(d["summary"]))'
  request GET "/experiments/$MAIN_EXP/runs?score_status=passed&sort=duration&dir=desc"
  check 'runs filter score_status=passed, sorted by duration' 200 \
    'd["matched"] == 10 and [r["durationS"] for r in d["rows"]] == sorted((r["durationS"] for r in d["rows"]), reverse=True)' \
    '"matched {} · {} s .. {} s".format(d["matched"], d["rows"][0]["durationS"], d["rows"][-1]["durationS"])'
  request GET "/experiments/$MAIN_EXP/runs?exec_error=1"
  check 'runs filter exec_error=1 -> none' 200 'd["matched"] == 0' '"matched {}".format(d["matched"])'
fi

if need 'run inspector (failed and passed runs)' "${FAILED_RUN:-}" "${PASSED_RUN:-}"; then
  for RID in "$FAILED_RUN" "$PASSED_RUN"; do
    WHICH="$([ "$RID" = "$FAILED_RUN" ] && echo 'failed total/baseline' || echo 'passed report/with-skill')"
    WANT="$([ "$RID" = "$FAILED_RUN" ] && echo failed || echo passed)"
    export WANT
    request GET "/runs/$RID"
    cp "$BODY" "$WORK/run.json"
    check "GET /runs/:id $WHICH: outcome" 200 \
      'd["status"] == "scored" and d["primary"]["status"] == env["WANT"] and d["scores"][0]["status"] == env["WANT"]' \
      '"{} · {}".format(d["scores"][0]["sentence"], d["scores"][0]["comment"][:70])'
    check "  timeline: real Hermes tool calls and model calls" 200 \
      'any(e["kind"] == "tool" and e["title"] == "terminal" and e["output"] for e in d["timeline"]["events"]) and sum(1 for e in d["timeline"]["events"] if e["kind"] == "network" and e["network"] and e["network"]["model"] == "mock/scripted" and e["network"]["status"] == 200) >= 2 and any(e["kind"] == "final" for e in d["timeline"]["events"])' \
      '" ".join("{}:{}".format(e["kind"], e["title"]) for e in d["timeline"]["events"] if e["kind"] in ("tool", "final"))'
    check "  finalResponse: extraction ranges" 200 \
      'd["finalResponse"]["extraction"] == "found" and json.loads(d["finalResponse"]["text"][d["finalResponse"]["extracted"]["start"]:d["finalResponse"]["extracted"]["end"]]) == d["finalResponse"]["parsed"] and d["finalResponse"]["text"][d["finalResponse"]["fence"]["start"]:d["finalResponse"]["fence"]["end"]].startswith("```")' \
      '"parsed {} · reference {}".format(json.dumps(d["finalResponse"]["parsed"]), json.dumps(d["finalResponse"]["reference"]))'
    check "  launch record: token as a placeholder, config.yaml" 200 \
      '"‹run token, revoked›" in d["launchRecord"]["command"] and "--provider custom" in d["launchRecord"]["command"] and "base_url: http://egress:8080/v1" in d["launchRecord"]["configYaml"]' \
      '"{} · {}".format(d["launchRecord"]["container"]["image"], d["launchRecord"]["container"]["network"])'
    check "  counterpart: the other configuration, scored" 200 \
      'd["counterpart"]["runId"] and d["counterpart"]["status"] == "scored" and d["counterpart"]["unavailableReason"] is None' \
      '"{configuration} {status}".format_map(d["counterpart"])'
    LAST_SEQ="$(jv 'max(e["seq"] for e in d["timeline"]["events"])' 2>/dev/null)"
    request GET "/runs/$RID/events?after=3"
    check "  GET /runs/:id/events?after=3 pages the rest" 200 \
      'all(e["seq"] > 3 or e["kind"] == "tool" for e in d["events"]) and len(d["events"]) >= 1 and not d["live"]' \
      '"{} rows · lastSeq {}".format(len(d["events"]), d["lastSeq"])'
    request GET "/runs/$RID/events?after=$(jv 'd["lastSeq"]' 2>/dev/null)"
    check "  GET /runs/:id/events?after=lastSeq is empty" 200 'd["events"] == []' '"lastSeq {}".format(d["lastSeq"])'
  done

  cp "$WORK/run.json" "$BODY"
  STATUS=200
  check 'report.csv collected as an agent artifact' 200 \
    'any(a["path"] == "workspace/report.csv" and a["origin"] == "agent" and a["sha256"] for a in d["artifacts"]["items"])' \
    '", ".join("{path} ({origin})".format_map(a) for a in d["artifacts"]["items"])'
  ARTIFACT_ID="$(jv 'next(a["id"] for a in d["artifacts"]["items"] if a["path"] == "workspace/report.csv")' 2>/dev/null)"
  if need 'GET /runs/:id/artifacts/:artifactId/content' "$ARTIFACT_ID"; then
    request GET "/runs/$PASSED_RUN/artifacts/$ARTIFACT_ID/content"
    if [ "$STATUS" = 200 ] && [ "$(cat "$BODY")" = "$(printf 'vendor,total\nAcme,12.00\nBorealis,5.50')" ]; then
      pass 'GET /runs/:id/artifacts/:artifactId/content' "$(wc -c <"$BODY" | tr -d ' ') bytes, as the agent wrote it"
    else
      fail 'GET /runs/:id/artifacts/:artifactId/content' "HTTP $STATUS: $(snippet)"
    fi
  fi
fi

if [ "$DOCKER" = 1 ] && [ -n "$MAIN_EXP" ]; then
  ROWS="$(psql_ro "select string_agg(t, ';') from (select a.id || ':' || count(*) || ':' || max(e.seq) || ':' || (bool_or(e.type = 'tool_use') and bool_or(e.type = 'tool_result'))::text || ':' || sum(case when e.payload->>'subtype' = 'network' then 1 else 0 end) as t from attempts a join runs r on r.id = a.run_id join run_events e on e.attempt_id = a.id where r.experiment_id = '$MAIN_EXP' group by a.id) x")"
  if python3 -c 'import sys; rows=[r.split(":") for r in sys.argv[1].split(";") if r]; sys.exit(0 if len(rows) == 12 and all(c == m and t == "true" and int(n) >= 2 for _, c, m, t, n in rows) else 1)' "$ROWS"; then
    pass 'run_events: 12 attempts, gap-free, tool_use+tool_result, network' "$(echo "$ROWS" | tr ';' '\n' | head -1)"
  else
    fail 'run_events: 12 attempts, gap-free, tool_use+tool_result, network' "$(echo "$ROWS" | cut -c1-200)"
  fi
  RECORDS="$(psql_ro "select json_agg(a.launch_record) from attempts a join runs r on r.id = a.run_id where r.experiment_id = '$MAIN_EXP'")"
  echo "$RECORDS" >"$BODY"
  STATUS=200
  check 'launch records: argv, config_yaml, inputs; no secret value' 200 \
    'len(d) == 12 and all(r["argv"][r["argv"].index("--api-key") + 1] == "<attempt-token>" and r["config_yaml"] and r["inputs"] for r in d) and "Bearer " not in raw and "@egress" not in raw' \
    '"secret_env_names " + ", ".join(d[0]["secret_env_names"])'
  LEFT="$(docker ps -a --filter name=hermes-evals-run- --format '{{.Names}}' | wc -l | tr -d ' ')"
  ATTEMPTS_LEFT="$(egress_attempts)"
  if [ "$LEFT" = 0 ] && [ "$ATTEMPTS_LEFT" = 0 ]; then
    pass 'no trial container and no egress registration left' 'containers 0 · egress attempts 0'
  else
    fail 'no trial container and no egress registration left' "containers $LEFT · egress attempts ${ATTEMPTS_LEFT:-?}"
  fi
  IDS="$(psql_ro "select string_agg(a.id, ' ') from attempts a join runs r on r.id = a.run_id where r.experiment_id = '$MAIN_EXP'")"
  DIRS="$(dc exec -T worker sh -c "for a in $IDS; do ls -A /trials/\$a | tr '\n' ' '; echo; done" 2>/dev/null | sort | uniq -c | sed 's/^ *//')"
  if [ "$DIRS" = '12 stderr.log workspace ' ]; then
    pass 'homes deleted; workspace and stderr.log kept' "12 trial directories: stderr.log workspace"
  else
    fail 'homes deleted; workspace and stderr.log kept' "$(echo "$DIRS" | tr '\n' ';')"
  fi
else
  skip 'raw rows, containers, egress and trial directories' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section 'Pause while running, then resume (slow task)'
# ---------------------------------------------------------------------------

EXP=''
if need 'POST /experiments (pause)' "$SUITE_ID" "$BASELINE_VERSION_ID" "$SKILL_VERSION_ID"; then
  launch "$PREFIX-pause" slow 2 2
  check 'POST /experiments (slow x 2 x 2, concurrency 2)' 201 'bool(d["id"])' '"experiment " + d["id"]'
fi
PAUSE_EXP="$EXP"
if need 'pause while running' "$PAUSE_EXP"; then
  if wait_for "/experiments/$PAUSE_EXP" 'd["counts"]["running"] == 2' 120; then
    pass 'two runs running' "$(jv '", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)')"
    sleep 5
    send_json POST "/experiments/$PAUSE_EXP/pause"
    check 'POST pause -> paused' 200 'd["status"] == "paused"' 'json.dumps(d)'
    if wait_for "/experiments/$PAUSE_EXP" 'd["counts"]["running"] + d["counts"]["executed"] + d["counts"]["scoring"] == 0' 180; then
      check 'in-flight runs finished, 2 still queued, paused (user)' 200 \
        'd["status"] == "paused" and d["pauseReason"] == "user" and d["counts"]["scored"] == 2 and d["counts"]["queued"] == 2' \
        '", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)'
      sleep 15
      request GET "/experiments/$PAUSE_EXP"
      check 'nothing new starts while paused (15 s later)' 200 \
        'd["status"] == "paused" and d["counts"]["queued"] == 2 and d["counts"]["running"] == 0' \
        '", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)'
    else
      fail 'in-flight runs finished, 2 still queued, paused (user)' "$(jv 'json.dumps(d["counts"])' 2>/dev/null)"
    fi
    send_json POST "/experiments/$PAUSE_EXP/resume" '{}'
    check 'POST resume -> running' 200 'd["status"] == "running"' 'json.dumps(d)'
    if wait_for "/experiments/$PAUSE_EXP" 'd["status"] in ("completed", "failed")' "$RUN_TIMEOUT"; then
      check 'resumed experiment completes, 4 scored' 200 \
        'd["status"] == "completed" and d["counts"]["scored"] == 4 and d["pausedAt"] is None' \
        '"{} in {} s".format(d["status"], d["elapsedS"])'
    else
      fail 'resumed experiment completes, 4 scored' "$(jv 'd["status"] + " " + json.dumps(d["counts"])' 2>/dev/null)"
    fi
  else
    fail 'two runs running' "$(jv 'd["status"] + " " + json.dumps(d["counts"])' 2>/dev/null)"
  fi
fi

# ---------------------------------------------------------------------------
section 'Cancel mid-run (slow task)'
# ---------------------------------------------------------------------------

EXP=''
if need 'POST /experiments (cancel)' "$SUITE_ID" "$BASELINE_VERSION_ID" "$SKILL_VERSION_ID"; then
  launch "$PREFIX-cancel" slow 2 2
  check 'POST /experiments (slow x 2 x 2, concurrency 2)' 201 'bool(d["id"])' '"experiment " + d["id"]'
fi
CANCEL_EXP="$EXP"
if need 'cancel mid-run' "$CANCEL_EXP"; then
  if wait_for "/experiments/$CANCEL_EXP" 'd["counts"]["running"] == 2' 120; then
    sleep 8
    T0="$(date +%s)"
    send_json POST "/experiments/$CANCEL_EXP/cancel"
    check 'POST cancel' 200 'bool(d["id"])' 'json.dumps(d)'
    if wait_for "/experiments/$CANCEL_EXP" 'd["status"] == "completed" and d["counts"]["cancelled"] == 4' 60; then
      pass 'running trials stopped, queued runs cancelled: 4 cancelled' "completed $(($(date +%s) - T0)) s after the cancel"
    else
      fail 'running trials stopped, queued runs cancelled: 4 cancelled' "$(jv 'd["status"] + " " + json.dumps(d["counts"])' 2>/dev/null)"
    fi
    request GET "/experiments/$CANCEL_EXP/runs"
    RID="$(jv 'next((r["id"] for r in d["rows"] if r["attempts"] == 1), "")' 2>/dev/null)"
    if need 'GET /runs/:id of a stopped run' "$RID"; then
      request GET "/runs/$RID"
      check 'GET /runs/:id of a stopped run: cancelled by experiment' 200 \
        'd["status"] == "cancelled" and d["cancelled"]["by"] == "experiment" and d["attempts"][0]["status"] == "cancelled"' \
        '"ran {} s · {}".format(d["cancelled"]["ranForS"], d["artifacts"]["note"])'
    fi
  else
    fail 'two runs running before the cancel' "$(jv 'd["status"] + " " + json.dumps(d["counts"])' 2>/dev/null)"
  fi
fi
if [ "$DOCKER" = 1 ]; then
  LEFT="$(docker ps -a --filter name=hermes-evals-run- --format '{{.Names}}' | wc -l | tr -d ' ')"
  ATTEMPTS_LEFT="$(egress_attempts)"
  if [ "$LEFT" = 0 ] && [ "$ATTEMPTS_LEFT" = 0 ]; then
    pass 'after pause and cancel: no container, no egress registration' 'containers 0 · egress attempts 0'
  else
    fail 'after pause and cancel: no container, no egress registration' "containers $LEFT · egress attempts ${ATTEMPTS_LEFT:-?}"
  fi
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
