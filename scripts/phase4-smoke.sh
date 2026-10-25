#!/usr/bin/env bash
# Phase 4 smoke test: the comparison and the verdict history on a running
# Hermes Evals stack, in real trial containers, with real Hermes against the
# scripted mock model, printing one PASS/FAIL/SKIP line per step. It covers
# Phase 4's exit check (one experiment reaches `better`, one stays
# `inconclusive`) and what stands behind it:
#
# - a temporary suite of four tasks, north, south, east and west, each with
#   two keys: `total` (numeric_tolerance, the primary key) and `note`
#   (text_match: "open rows", and on west also "USD");
# - a skill and three configurations: smoke-baseline, smoke-with-skill (the
#   skill) and smoke-twin (no skill, a different max_turns). The mock answers
#   every total right when the skill's phrase is in the system prompt, but
#   says EUR in its note (so west's note fails); without it, it gets north,
#   south and east wrong and west right (scripts/phase4-mock-scripts.json);
# - experiment A, 4 tasks x baseline and with-skill x 3 repetitions: while
#   nothing is scored, the comparison is provisional; once it has
#   completed, `better` on the primary key, Δ +0.75 [+0.25, +1.00], 3 tasks
#   improved and 1 unchanged; the pass rates and counts, the cells, the
#   filters and their counts, the secondary metrics and the progress; the key
#   selector, where `note` (Δ -0.25 [-0.75, 0]) and `any_failed` (Δ +0.50
#   [-0.50, +1.00]) are `inconclusive`; the refusals (400, 404); the verdict
#   entry the completion appended (cause initial) on the Overview, the list
#   and the configuration's usage;
# - experiment B, north and west x baseline and twin x 3, one run at a time
#   (so its last run leaves time to look): while that run runs, the
#   comparison has statistics marked provisional and the Overview, the list
#   and the twin's usage read provisional; then both answer the same, Δ 0
#   [0, 0], `inconclusive`;
# - experiment C, north and west x baseline and with-skill x 1 repetition:
#   no statistics, `not_computable` (single_repetition);
# - a re-score of one run of A: generation 2 publishes, the results revision
#   moves, a second verdict entry (cause rescore, "1 run re-scored") is
#   appended once, the comparison answers at the new revision, and the live
#   stream sends the run's re-score and the experiment's verdict change.
#
# Every interval follows from the task list alone (4 tasks, 10,000 resamples;
# a quantile sits well inside one step of the resampled means), so the
# numbers are exact whatever the experiment's seed.
#
#   scripts/phase4-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase4-smoke.sh  # through nginx
#
# The stack needs the mock model (profile `test`) with the scripts in
# scripts/phase4-mock-scripts.json. Compose reads MOCK_SCRIPTS from the shell
# before .env, so no file changes:
#
#   MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase4-mock-scripts.json"))))')" \
#     docker compose --profile test up -d
#
# No task has an llm_judge check, so no judge setting is needed. To run the
# Phase 2 and 3 smoke tests on the same stack, put the Phase 4 scripts first
# in the Phase 3 start (their phrases occur nowhere else):
#
#   MOCK_SCRIPTS="$(python3 -c 'import json; print(json.dumps(json.load(open("scripts/phase4-mock-scripts.json")) + json.load(open("scripts/phase3-mock-scripts.json")) + json.load(open("scripts/phase2-mock-scripts.json"))))')" \
#   JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
#     docker compose --profile test up -d
#
# Every configuration uses provider `custom` with base URL
# http://mock-model:8090/v1 and model mock/scripted, which config/prices.yaml
# prices at 0: no real provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl and python3. Exits 0 only when no step
# failed. It writes to the stack it tests, so point it at a development stack
# only. Every name it creates starts with smoke-<UTC timestamp> (the suite
# directory zz-smoke-stats-<timestamp>), so it can run again and again. The
# suite directory is removed at the end and reloaded, which leaves its
# suite_sources row `missing`; the experiments, configurations and skill stay
# (there are no delete endpoints).
#
# Settings (environment):
#   BASE_URL       API base URL (default http://localhost:3000/api)
#   SUITES_DIR     host directory the worker reads suites from (default <repo>/suites)
#   SMOKE_DOCKER   auto (default) | 0: also check, read-only through `docker compose`,
#                  the mock's scripts, migration 0007 and the stored verdict history
#                  and revisions
#   RUN_TIMEOUT    seconds the three experiments may take together, and a re-score
#                  (default 600)
#   CURL_TIMEOUT   seconds per request (default 120)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
RUN_TIMEOUT="${RUN_TIMEOUT:-600}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
SUITE_NAME="zz-smoke-stats-$STAMP"
SUITE_DIR="$SUITES_DIR/$SUITE_NAME"
BASELINE_NAME="$PREFIX-baseline"
SKILLED_NAME="$PREFIX-with-skill"
TWIN_NAME="$PREFIX-twin"
SKILL_NAME="$PREFIX-stats-method"
# Matched by scripts/phase4-mock-scripts.json in smoke-with-skill's system prompt.
SKILL_PHRASE='smoke-stats-method: count only the open rows of the region the task names'
export PREFIX SUITE_NAME BASELINE_NAME SKILLED_NAME TWIN_NAME SKILL_NAME

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "phase4-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase4-smoke.XXXXXX")"
export WORK
BODY="$WORK/body"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
SSE_PID=''

# ---------------------------------------------------------------------------
# Helpers (as in phase3-smoke.sh)
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
      -H 'X-Requested-With: phase4-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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
# response) as `d`, with `env`, `json`, `raw`, `row` (row(d, task): that
# task's comparison row) and `ex` (the expected figures below). A string
# prints as it is, anything else as JSON. str.format, not f-strings (Python
# before 3.12).
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
def row(view, task):
    return next(r for r in view['rows'] if r['taskKey'] == task)
def stats(view):
    s = view['statistics']
    return (s['verdict'], s['observedDelta'], s['lo'], s['hi'])
try:
    value = eval(expr, {'d': d, 'env': os.environ, 'json': json, 'raw': raw, 'row': row, 'stats': stats})
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

# compare EXP [QUERY]: GET /experiments/EXP/comparison[?QUERY].
compare() {
  if [ -n "${2:-}" ]; then request GET "/experiments/$1/comparison?$2"; else request GET "/experiments/$1/comparison"; fi
}

# Docker checks run when the stack is this repository's Compose project here.
DOCKER=0
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null &&
  (cd "$REPO_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx worker); then
  DOCKER=1
fi
dc() { (cd "$REPO_DIR" && docker compose "$@"); }
psql_ro() { dc exec -T postgres psql -U hermes -d hermes_evals -At -c "$1" 2>/dev/null; }
# revisions EXP: "results_revision verdict_revision history_length" of one experiment.
revisions() {
  psql_ro "select results_revision || ' ' || verdict_revision || ' ' || jsonb_array_length(verdict_history) from experiments where id = '$1'"
}

# Stops the live stream if a step left it open, removes the temporary suite
# directory (and reloads it, so it is `missing`), then the work directory.
cleanup() {
  [ -n "$SSE_PID" ] && kill "$SSE_PID" 2>/dev/null
  if [ -d "$SUITE_DIR" ]; then
    rm -rf "$SUITE_DIR"
    send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'Phase 4 smoke · %s · stamp %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

# ---------------------------------------------------------------------------
section 'Stack'
# ---------------------------------------------------------------------------

request GET /health
check 'GET /health' 200 \
  'd["status"] == "ok" and all(v == "ok" for v in d["checks"].values())' \
  '"status " + d["status"] + " · " + ", ".join(k + " " + v for k, v in d["checks"].items())'

request GET /system/workers
check 'GET /system/workers: online, sandbox proven, effective concurrency' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] and w["effectiveConcurrency"] == max(1, min(w["concurrency"], w["slotsTotal"] or w["concurrency"])) for w in d)' \
  '"; ".join("{} concurrency {} effective {} slots {}".format(w["id"], w["concurrency"], w["effectiveConcurrency"], w["slotsTotal"]) for w in d if w["status"] == "online")'

request GET /docs-json
check 'the API document lists GET /experiments/{id}/comparison' 200 \
  '"/api/experiments/{id}/comparison" in d["paths"] and "ComparisonView" in d["components"]["schemas"]' \
  '"{} paths".format(len(d["paths"]))'

if [ "$DOCKER" = 1 ]; then
  if dc exec -T mock-model printenv MOCK_SCRIPTS 2>/dev/null | grep -q 'smoke-stats-method'; then
    pass 'the mock model has scripts/phase4-mock-scripts.json' 'MOCK_SCRIPTS matches the skill phrase, "Smoke stats task NORTH", ...'
  else
    fail 'the mock model has scripts/phase4-mock-scripts.json' 'start it as the header says (profile test, MOCK_SCRIPTS)'
  fi
  MIGRATIONS="$(psql_ro 'select count(*) from drizzle.__drizzle_migrations')"
  LIMIT_CK="$(psql_ro "select count(*) from pg_constraint where conname = 'attempts_error_category_ck' and pg_get_constraintdef(oid) like '%''limit''%'")"
  if [ "${MIGRATIONS:-0}" -ge 8 ] && [ "$LIMIT_CK" = 1 ]; then
    pass 'migration 0007: attempts accept the category limit' "$MIGRATIONS migrations applied"
  else
    fail 'migration 0007: attempts accept the category limit' "migrations ${MIGRATIONS:-?} · CHECK with limit: ${LIMIT_CK:-?}; rebuild the api image"
  fi
else
  skip 'the mock scripts, migration 0007' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section "Suite (temporary directory suites/$SUITE_NAME)"
# ---------------------------------------------------------------------------

python3 - "$SUITE_DIR" "$SUITE_NAME" <<'PY'
import json, os, sys
root, name = sys.argv[1], sys.argv[2]
def put(path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(text)
amounts = ('id,region,amount,status\nN1,north,100.00,open\nN2,north,250.50,paid\nN3,north,49.50,open\n'
           'S1,south,75.25,open\nS2,south,20.00,paid\nE1,east,1000.00,open\nE2,east,42.50,open\n'
           'W1,west,12.00,open\nW2,west,8.00,paid\n')
totals = {'north': 149.5, 'south': 75.25, 'east': 1042.5, 'west': 12.0}
put('suite.yaml', "name: {}\nversion_label: '0.1'\ndescription: Temporary Phase 4 smoke suite, graded against the scripted mock model.\n"
    'tasks: [north, south, east, west]\n'.format(name))
for region, total in totals.items():
    usd = region == 'west'
    phrases = '[open rows, USD]' if usd else '[open rows]'
    put(region + '/task.yaml', 'summary: The open {} amount in amounts.csv\n'.format(region) +
        'limits:\n  max_turns: 10\n  run_budget_seconds: 120\n  toolsets_needed: [terminal]\n'
        'answer:\n  format: fenced_json\n  path: {}\n'.format(region) +
        'verification:\n'
        '  - key: total\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n'
        '  - key: note\n    type: text_match\n    params: { path: note, contains: ' + phrases + ' }\n')
    put(region + '/prompt.md',
        'Smoke stats task {}. Add up the `amount` of the open rows of `amounts.csv` whose region is {}. '
        'In `note`, say which rows you counted{}.\n\nEnd your reply with a fenced JSON block:\n\n'
        '```json\n{{ "{}": 0.0, "note": "" }}\n```\n'.format(
            region.upper(), region, ' and the currency: the west amounts are in USD' if usd else '', region))
    put(region + '/fixtures/amounts.csv', amounts)
    put(region + '/reference.json', json.dumps(
        {region: total, 'note': 'Only the open rows count' + (', in USD.' if usd else '.')}, indent=2) + '\n')
PY

send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
check 'reload the new directory -> created v1' 200 \
  'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1' \
  '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
SUITE_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"
export SUITE_ID

if need 'suite detail: 4 valid tasks, each self-check passed' "$SUITE_ID"; then
  request GET "/suites/$SUITE_ID"
  check 'suite detail: 4 valid tasks' 200 \
    'd["validCount"] == d["taskCount"] == 4 and sorted(t["key"] for t in d["tasks"]) == ["east", "north", "south", "west"]' \
    '", ".join("{} v{} {}".format(t["key"], t["version"], "valid" if t["valid"] else "INVALID") for t in d["tasks"])'
  for TASK in north south east west; do
    request GET "/suites/$SUITE_ID/tasks/$TASK"
    check "  $TASK: keys total (primary) and note, self-check passed" 200 \
      '[(v["key"], v["type"], v["primary"]) for v in d["verification"]] == [("total", "numeric_tolerance", True), ("note", "text_match", False)] and d["selfCheck"]["status"] == "passed"' \
      '", ".join("{}:{}".format(r["key"], r["status"]) for r in d["selfCheck"]["results"])'
  done
fi

# ---------------------------------------------------------------------------
section 'Skill and configurations'
# ---------------------------------------------------------------------------

SKILL_ZIP="$WORK/$SKILL_NAME.zip"
python3 - "$SKILL_ZIP" "$SKILL_NAME" "$SKILL_PHRASE" <<'PY'
import sys, zipfile
path, name, phrase = sys.argv[1:4]
md = ('---\nname: {}\nversion: 1.0.0\ndescription: Smoke-test skill. How to total a region of a ledger.\n---\n\n'
      '# Stats method\n\n{}. Paid rows never count.\n').format(name, phrase)
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(name + '/SKILL.md', md)
PY
request POST /resources/skills/validate -F "file=@$SKILL_ZIP;type=application/zip"
SKILL_TOKEN="$(jv 'd["token"]' 2>/dev/null)"
SKILL_ID=''
if need 'POST /resources/skills (validate, confirm)' "$SKILL_TOKEN"; then
  send_json POST /resources/skills "{\"token\":\"$SKILL_TOKEN\"}"
  check 'POST /resources/skills (validate, confirm)' 201 'd["name"] == env["SKILL_NAME"]' '"{name}@{version}".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
fi

# config_body NAME SKILL_IDS MAX_TURNS: a configuration on the mock model.
config_body() {
  printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":["file","terminal"],"memoryEnabled":false,"skillIds":[%s],"documentIds":[],"mcpServerVersionIds":[],"maxTurns":%s,"timeBudgetS":120,"duplicatedFromVersionId":null}' "$1" "$2" "$3"
}
# create_config NAME SKILL_IDS MAX_TURNS LABEL: POST /configurations; sets CONFIG_ID and VERSION_ID.
create_config() {
  CONFIG_ID=''
  VERSION_ID=''
  send_json POST /configurations "$(config_body "$1" "$2" "$3")"
  check "POST /configurations $1 ($4)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)' || return 0
  CONFIG_ID="$(jv 'd["configurationId"]' 2>/dev/null)"
  VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
}
create_config "$BASELINE_NAME" '' 10 'no skill'
BASELINE_CONFIG="$CONFIG_ID"
BASELINE_VERSION="$VERSION_ID"
SKILLED_CONFIG=''
SKILLED_VERSION=''
if need "POST /configurations $SKILLED_NAME" "$SKILL_ID"; then
  create_config "$SKILLED_NAME" "\"$SKILL_ID\"" 10 'the skill'
  SKILLED_CONFIG="$CONFIG_ID"
  SKILLED_VERSION="$VERSION_ID"
fi
create_config "$TWIN_NAME" '' 8 'no skill, max_turns 8'
TWIN_CONFIG="$CONFIG_ID"
TWIN_VERSION="$VERSION_ID"
export BASELINE_CONFIG BASELINE_VERSION SKILLED_CONFIG SKILLED_VERSION TWIN_CONFIG TWIN_VERSION

CONCURRENCY=3
if need 'GET /experiments/new-options: 4 valid tasks' "$SUITE_ID"; then
  request GET /experiments/new-options
  check 'GET /experiments/new-options: 4 valid tasks' 200 \
    'any(s["suiteId"] == env["SUITE_ID"] and sum(t["valid"] for t in s["tasks"]) == 4 for s in d["suites"])' \
    '"max concurrency {}".format(d["maxConcurrency"])'
  cp "$BODY" "$WORK/options.json"
  CONCURRENCY="$(jv 'max(1, min(3, d["maxConcurrency"]))' 2>/dev/null || echo 3)"
fi
export CONCURRENCY

# launch NAME TASKS CANDIDATE_VERSION REPETITIONS [CONCURRENCY]: POST
# /experiments on the temporary suite, the baseline against one candidate;
# the id lands in $EXP.
launch() {
  local body
  EXP=''
  body="$(python3 - "$WORK/options.json" "$1" "$2" "$3" "$4" "${5:-$CONCURRENCY}" <<'PY'
import json, os, sys
options, name, tasks, candidate, reps, concurrency = sys.argv[1:7]
o = json.load(open(options))
h = {c['versionId']: c['configHash'] for c in o['configurations']}
b = os.environ['BASELINE_VERSION']
print(json.dumps({'name': name, 'description': 'phase4-smoke: ' + name, 'suiteId': os.environ['SUITE_ID'],
                  'taskKeys': tasks.split(','), 'baselineVersionId': b, 'candidateVersionIds': [candidate],
                  'repetitions': int(reps), 'concurrency': int(concurrency), 'spendCeilingUsd': None,
                  'timeBudgetOverrideS': None, 'expectedConfigHashes': {b: h[b], candidate: h[candidate]}}))
PY
  )" || return 0
  send_json POST /experiments "$body"
  [ "$STATUS" = 201 ] && EXP="$(jv 'd["id"]' 2>/dev/null)"
  return 0
}

# ---------------------------------------------------------------------------
section 'Launch: A (4 x 2 x 3), B (2 x 2 x 3, the twin, one at a time), C (2 x 2 x 1)'
# ---------------------------------------------------------------------------

A_EXP=''
B_EXP=''
C_EXP=''
if need 'POST /experiments A, B and C' "$SUITE_ID" "$BASELINE_VERSION" "$SKILLED_VERSION" "$TWIN_VERSION"; then
  launch "$PREFIX-a-better" north,south,east,west "$SKILLED_VERSION" 3
  check 'POST /experiments A: 4 tasks x baseline, with-skill x 3' 201 'bool(d["id"])' '"experiment " + d["id"]'
  A_EXP="$EXP"
  launch "$PREFIX-b-same" north,west "$TWIN_VERSION" 3 1
  check 'POST /experiments B: north, west x baseline, twin x 3, concurrency 1' 201 'bool(d["id"])' '"experiment " + d["id"]'
  B_EXP="$EXP"
  launch "$PREFIX-c-single" north,west "$SKILLED_VERSION" 1
  check 'POST /experiments C: north, west x baseline, with-skill x 1' 201 'bool(d["id"])' '"experiment " + d["id"]'
  C_EXP="$EXP"
fi
export A_EXP B_EXP C_EXP

# The three experiments share one deadline; left: the seconds still to go (at least 1).
DEADLINE=$(($(date +%s) + RUN_TIMEOUT))
left() {
  local n=$((DEADLINE - $(date +%s)))
  [ "$n" -lt 1 ] && n=1
  echo "$n"
}

if need 'comparison while A runs: provisional' "$A_EXP"; then
  compare "$A_EXP"
  check 'comparison while A runs: provisional, 24 runs to go' 200 \
    'd["experimentStatus"] == "running" and d["provisional"] and d["progress"]["total"] == 24 and d["progress"]["scored"] < 24 and (d["statistics"] is None or d["statistics"]["verdict"] == "provisional")' \
    '"progress {scored}/{total} · ".format_map(d["progress"]) + (d["statisticsUnavailable"]["reason"] + ": " + d["statisticsUnavailable"]["message"][:80] if d["statisticsUnavailable"] else "verdict " + d["statistics"]["verdict"])'
fi

# B runs one run at a time, so once every task has 2 counted runs a side its
# last run is still to come: statistics marked provisional. Each read checks
# B still runs; a slow poll that sees it completed SKIPs.
if need 'comparison while B runs: provisional statistics' "$B_EXP"; then
  if wait_for "/experiments/$B_EXP/comparison" 'd["statistics"] is not None or d["experimentStatus"] != "running"' "$(left)" &&
    [ "$(jv 'd["experimentStatus"]' 2>/dev/null)" = running ]; then
    check 'comparison while B runs: provisional statistics' 200 \
      'd["provisional"] and d["statistics"]["provisional"] and d["statistics"]["verdict"] == "provisional" and d["statisticsUnavailable"] is None and [c["verdict"] for c in d["candidates"]] == ["provisional"] and d["progress"]["scored"] < d["progress"]["total"] == 12' \
      '"progress {scored}/{total} · ".format_map(d["progress"]) + "Δ {observedDelta} [{lo}, {hi}] {verdict}".format_map(d["statistics"])'
    request GET "/experiments/$B_EXP"
    if [ "$(jv 'd["status"]' 2>/dev/null)" = running ]; then
      check '  Overview while B runs: provisional, no history yet' 200 \
        '[(v["verdict"], v["history"]) for v in d["verdicts"]] == [("provisional", [])]' \
        '"{verdict} Δ {delta} [{lo}, {hi}]".format_map(d["verdicts"][0])'
    else
      skip '  Overview while B runs: provisional, no history yet' 'B completed meanwhile'
    fi
    request GET /experiments
    if [ "$(jv 'next(r for r in d if r["id"] == env["B_EXP"])["status"]' 2>/dev/null)" = running ]; then
      check '  list while B runs: no verdict chip yet' 200 \
        'next(r for r in d if r["id"] == env["B_EXP"])["verdicts"] == []' \
        '"doneRuns {}".format(next(r for r in d if r["id"] == env["B_EXP"])["doneRuns"])'
    else
      skip '  list while B runs: no verdict chip yet' 'B completed meanwhile'
    fi
    request GET "/configurations/$TWIN_CONFIG"
    if [ "$(jv 'next(u for u in d["usedIn"] if u["experimentId"] == env["B_EXP"])["status"]' 2>/dev/null)" = running ]; then
      check '  the twin'"'"'s usage while B runs: provisional' 200 \
        'next(u for u in d["usedIn"] if u["experimentId"] == env["B_EXP"])["verdict"] == "provisional"' \
        '"{role} {status} {verdict} {scored}/{total}".format_map(next(u for u in d["usedIn"] if u["experimentId"] == env["B_EXP"]))'
    else
      skip '  the twin'"'"'s usage while B runs: provisional' 'B completed meanwhile'
    fi
  else
    skip 'comparison while B runs: provisional statistics' 'B completed between two polls'
  fi
fi

# settles NAME ID RUNS: waits (within the shared deadline) for the
# experiment to settle, then checks it completed with RUNS runs scored.
settles() {
  if wait_for "/experiments/$2" 'd["status"] in ("completed", "failed")' "$(left)"; then
    RUNS="$3" check "$1: completes, $3 of $3 runs scored" 200 \
      'd["status"] == "completed" and d["counts"]["scored"] == int(env["RUNS"]) and d["totalRuns"] == int(env["RUNS"])' \
      '"{} in {} s".format(d["status"], d["elapsedS"])'
  else
    fail "$1: completes, $3 of $3 runs scored" "still $(jv 'd["status"] + " " + json.dumps({k: v for k, v in d["counts"].items() if v})' 2>/dev/null) after ${RUN_TIMEOUT} s"
  fi
}

# ---------------------------------------------------------------------------
section 'Experiment A: the skill improves 3 tasks of 4 -> better'
# ---------------------------------------------------------------------------

A_RESCORE_RUN=''
if need 'experiment A' "$A_EXP"; then
  settles 'A' "$A_EXP" 24
  compare "$A_EXP"
  cp "$BODY" "$WORK/a-primary.json"
  check 'comparison: better, Δ +0.75 [+0.25, +1.00], final' 200 \
    'stats(d) == ("better", 0.75, 0.25, 1.0) and d["statistics"]["resamples"] == 10000 and d["statistics"]["confidence"] == 0.95 and not d["statistics"]["provisional"] and not d["provisional"] and d["experimentStatus"] == "completed" and d["statisticsUnavailable"] is None and d["scoreKey"] == "primary" and d["filter"] == "all"' \
    '"Δ {observedDelta:+} [{lo:+}, {hi:+}] {verdict} · {resamples} resamples".format_map(d["statistics"])'
  check '  pass rates 0.25 -> 1.00, counts 3/12 and 12/12' 200 \
    'd["passRates"] == {"baseline": 0.25, "candidate": 1} and d["passCounts"] == {"baseline": {"passed": 3, "counted": 12}, "candidate": {"passed": 12, "counted": 12}}' \
    '"baseline {} ({passed}/{counted})".format(d["passRates"]["baseline"], **d["passCounts"]["baseline"]) + " · with-skill {} ({passed}/{counted})".format(d["passRates"]["candidate"], **d["passCounts"]["candidate"])'
  check '  filter counts 3 improved, 0 regressed, 1 unchanged; rows by Δ' 200 \
    'd["filterCounts"] == {"all": 4, "improved": 3, "regressed": 0, "unchanged": 1} and [(r["taskKey"], r["passBaseline"], r["passCandidate"], r["delta"], r["change"]) for r in d["rows"]] == [("east", 0, 1, 1, "improved"), ("north", 0, 1, 1, "improved"), ("south", 0, 1, 1, "improved"), ("west", 1, 1, 0, "unchanged")]' \
    '"; ".join("{} {}->{} {}".format(r["taskKey"], r["passBaseline"], r["passCandidate"], r["change"]) for r in d["rows"])'
  check '  cells: 3 repetitions a side, scored, the selected key, a comment' 200 \
    'all([c["repetition"] for c in r[side]] == [1, 2, 3] and all(c["runStatus"] == "scored" and c["attempt"] == 1 and c["durationS"] > 0 and c["comment"] for c in r[side]) for r in d["rows"] for side in ("baseline", "candidate")) and [c["scoreStatus"] for r in d["rows"] for c in r["baseline"]] == ["failed"] * 9 + ["passed"] * 3 and all(c["scoreStatus"] == "passed" for r in d["rows"] for c in r["candidate"])' \
    '"north baseline: " + row(d, "north")["baseline"][0]["comment"][:70]'
  check '  secondary metrics: both configurations, no errors, priced at $0' 200 \
    '[s["configuration"]["name"] for s in d["secondary"]] == [env["BASELINE_NAME"], env["SKILLED_NAME"]] and all(s["medianDurationS"] > 0 and s["meanTokens"] > 0 and s["costUsd"] == 0 and s["executionErrors"] == 0 and s["executionErrorCategories"] == [] and s["ungradable"] == 0 for s in d["secondary"]) and d["secondaryDifference"]["executionErrors"] == 0 and d["secondaryDifference"]["costUsd"] == 0 and d["sensitivity"] is None' \
    '"; ".join("{} median {} s, {:.0f} tokens".format(s["configuration"]["name"][len(env["PREFIX"]) + 1:], s["medianDurationS"], s["meanTokens"]) for s in d["secondary"]) + " · tokens {:+.1f}%".format(d["secondaryDifference"]["meanTokensPct"])'
  check '  progress 24/24; the candidate select; the key options' 200 \
    'd["progress"] == {"scored": 24, "total": 24} and d["repetitions"] == 3 and d["baseline"]["versionId"] == env["BASELINE_VERSION"] and d["candidate"]["versionId"] == env["SKILLED_VERSION"] and [(c["configuration"]["versionId"], c["verdict"]) for c in d["candidates"]] == [(env["SKILLED_VERSION"], "better")] and {"primary", "any_failed", "total", "note"} <= {o["value"] for o in d["scoreKeyOptions"]}' \
    '"keys: " + ", ".join(o["value"] for o in d["scoreKeyOptions"])'
  A_RESCORE_RUN="$(jv 'row(d, "west")["candidate"][0]["runId"]' "$WORK/a-primary.json" 2>/dev/null)"

  for FILTER in improved regressed unchanged; do
    compare "$A_EXP" "filter=$FILTER"
    FILTER="$FILTER" check "  ?filter=$FILTER" 200 \
      'd["filter"] == env["FILTER"] and [r["taskKey"] for r in d["rows"]] == {"improved": ["east", "north", "south"], "regressed": [], "unchanged": ["west"]}[env["FILTER"]] and d["filterCounts"] == {"all": 4, "improved": 3, "regressed": 0, "unchanged": 1} and stats(d) == ("better", 0.75, 0.25, 1.0)' \
      '"{} rows: {}".format(len(d["rows"]), ", ".join(r["taskKey"] for r in d["rows"]) or "none")'
  done

  compare "$A_EXP" 'key=total'
  check '  ?key=total (the primary key by name): the same answer' 200 \
    'd["scoreKey"] == "total" and stats(d) == ("better", 0.75, 0.25, 1.0) and d["filterCounts"]["improved"] == 3' \
    '"Δ {observedDelta:+} [{lo:+}, {hi:+}] {verdict}".format_map(d["statistics"])'
  compare "$A_EXP" 'key=note'
  check '  ?key=note: west regressed, Δ -0.25 [-0.75, 0], inconclusive' 200 \
    'd["scoreKey"] == "note" and stats(d) == ("inconclusive", -0.25, -0.75, 0) and d["filterCounts"] == {"all": 4, "improved": 0, "regressed": 1, "unchanged": 3} and d["passCounts"] == {"baseline": {"passed": 12, "counted": 12}, "candidate": {"passed": 9, "counted": 12}} and [c["scoreStatus"] for c in row(d, "west")["candidate"]] == ["failed"] * 3 and [c["scoreStatus"] for c in row(d, "north")["baseline"]] == ["passed"] * 3' \
    '"Δ {observedDelta:+} [{lo:+}, {hi:+}] {verdict} · ".format_map(d["statistics"]) + "west with-skill: " + row(d, "west")["candidate"][0]["comment"][:60]'
  compare "$A_EXP" 'key=any_failed'
  check '  ?key=any_failed: 3 improved, west regressed, Δ +0.50 [-0.50, +1.00]' 200 \
    'd["scoreKey"] == "any_failed" and stats(d) == ("inconclusive", 0.5, -0.5, 1.0) and d["filterCounts"] == {"all": 4, "improved": 3, "regressed": 1, "unchanged": 0} and d["passRates"] == {"baseline": 0.25, "candidate": 0.75}' \
    '"Δ {observedDelta:+} [{lo:+}, {hi:+}] {verdict}".format_map(d["statistics"])'
  compare "$A_EXP" 'key=any_failed&filter=regressed'
  check '  ?key=any_failed&filter=regressed: west' 200 \
    '[r["taskKey"] for r in d["rows"]] == ["west"] and d["rows"][0]["change"] == "regressed" and d["rows"][0]["delta"] == -1' \
    '"west {}->{}".format(d["rows"][0]["passBaseline"], d["rows"][0]["passCandidate"])'

  compare "$A_EXP" 'key=nope'
  check '  ?key=nope -> 400' 400 'd["statusCode"] == 400 and "nope" in d["message"]' 'd["message"]'
  compare "$A_EXP" "candidate=$BASELINE_VERSION"
  check '  ?candidate=<the baseline> -> 400' 400 'd["statusCode"] == 400 and env["BASELINE_VERSION"] in d["message"]' 'd["message"]'
  compare "$A_EXP" 'filter=bogus'
  check '  ?filter=bogus -> 400' 400 'd["statusCode"] == 400 and [i["path"] for i in d["issues"]] == ["filter"]' 'd["message"] + ": " + json.dumps(d["issues"])[:90]'
  compare 01K8ZZZZZZZZZZZZZZZZZZZZZZ
  check '  an unknown experiment -> 404' 404 'd["statusCode"] == 404' 'd["message"]'

  request GET "/experiments/$A_EXP"
  check 'Overview: the verdict is better, one entry (cause initial)' 200 \
    'len(d["verdicts"]) == 1 and (d["verdicts"][0]["verdict"], d["verdicts"][0]["delta"], d["verdicts"][0]["lo"], d["verdicts"][0]["hi"]) == ("better", 0.75, 0.25, 1.0) and d["verdicts"][0]["scoreKey"] == "primary" and d["verdicts"][0]["reason"] is None and d["verdicts"][0]["taskCounts"] == {"improved": 3, "regressed": 0, "unchanged": 1} and d["verdicts"][0]["method"] == {"name": "paired_bootstrap", "resamples": 10000, "confidence": 0.95} and [(h["cause"], h["verdict"], h["note"]) for h in d["verdicts"][0]["history"]] == [("initial", "better", None)]' \
    '"{verdict} Δ {delta:+} [{lo:+}, {hi:+}] · ".format_map(d["verdicts"][0]) + " · ".join("{cause} at {at}".format_map(h) for h in d["verdicts"][0]["history"])'
  request GET /experiments
  check 'experiment list: the chip reads better' 200 \
    '[(v["candidate"], v["verdict"], v["delta"], v["lo"], v["hi"]) for v in next(r for r in d if r["id"] == env["A_EXP"])["verdicts"]] == [(env["SKILLED_NAME"], "better", 0.75, 0.25, 1.0)]' \
    'json.dumps(next(r for r in d if r["id"] == env["A_EXP"])["verdicts"][0])'
  if need 'configuration usage' "$SKILLED_CONFIG" "$BASELINE_CONFIG"; then
    request GET "/configurations/$SKILLED_CONFIG"
    check 'configuration usage: with-skill, candidate in A, better vs 0.25' 200 \
      '[(u["role"], u["status"], u["verdict"], u["passRate"], u["baselinePassRate"], u["repetitions"], u["scored"], u["total"]) for u in d["usedIn"] if u["experimentId"] == env["A_EXP"]] == [("candidate", "completed", "better", 1, 0.25, 3, 12, 12)]' \
      '"; ".join("{} {} {} {}".format(u["experimentName"][len(env["PREFIX"]) + 1:], u["role"], u["verdict"], u["passRate"]) for u in d["usedIn"])'
    request GET "/configurations/$BASELINE_CONFIG"
    check 'configuration usage: baseline in A, no verdict of its own' 200 \
      '[(u["role"], u["verdict"], u["passRate"]) for u in d["usedIn"] if u["experimentId"] == env["A_EXP"]] == [("baseline", None, 0.25)]' \
      '"used in {} experiments".format(len(d["usedIn"]))'
  fi
fi

# ---------------------------------------------------------------------------
section 'Experiment B: both configurations answer the same -> inconclusive'
# ---------------------------------------------------------------------------

if need 'experiment B' "$B_EXP"; then
  settles 'B' "$B_EXP" 12
  compare "$B_EXP"
  check 'comparison: inconclusive, Δ 0 [0, 0], 2 tasks unchanged' 200 \
    'stats(d) == ("inconclusive", 0, 0, 0) and d["filterCounts"] == {"all": 2, "improved": 0, "regressed": 0, "unchanged": 2} and d["passRates"] == {"baseline": 0.5, "candidate": 0.5} and [(r["taskKey"], r["passBaseline"], r["passCandidate"], r["delta"], r["change"]) for r in d["rows"]] == [("north", 0, 0, 0, "unchanged"), ("west", 1, 1, 0, "unchanged")] and d["candidate"]["versionId"] == env["TWIN_VERSION"]' \
    '"Δ {observedDelta} [{lo}, {hi}] {verdict}".format_map(d["statistics"])'
  request GET "/experiments/$B_EXP"
  check 'Overview: inconclusive, one entry (cause initial)' 200 \
    '[(v["verdict"], [h["cause"] for h in v["history"]]) for v in d["verdicts"]] == [("inconclusive", ["initial"])]' \
    '"{verdict} Δ {delta} [{lo}, {hi}]".format_map(d["verdicts"][0])'
  request GET /experiments
  check 'experiment list: the chip reads inconclusive' 200 \
    '[v["verdict"] for v in next(r for r in d if r["id"] == env["B_EXP"])["verdicts"]] == ["inconclusive"]'
fi

# ---------------------------------------------------------------------------
section 'Experiment C: one repetition -> not computable'
# ---------------------------------------------------------------------------

if need 'experiment C' "$C_EXP"; then
  settles 'C' "$C_EXP" 4
  compare "$C_EXP"
  check 'comparison: no statistics, single_repetition, with the sentence' 200 \
    'd["statistics"] is None and d["statisticsUnavailable"]["reason"] == "single_repetition" and d["statisticsUnavailable"]["message"].startswith("No interval with 1 repetition") and "2 tasks" in d["statisticsUnavailable"]["message"] and d["repetitions"] == 1 and all(r["delta"] is None and len(r["baseline"]) == len(r["candidate"]) == 1 for r in d["rows"]) and d["passRates"] == {"baseline": 0.5, "candidate": 1}' \
    'd["statisticsUnavailable"]["message"]'
  request GET "/experiments/$C_EXP"
  check 'Overview: not_computable (single_repetition), one entry (cause initial)' 200 \
    '[(v["verdict"], v["reason"], v["delta"], v["lo"], [h["cause"] for h in v["history"]]) for v in d["verdicts"]] == [("not_computable", "single_repetition", None, None, ["initial"])]' \
    '"{verdict} ({reason})".format_map(d["verdicts"][0])'
  request GET /experiments
  check 'experiment list: the chip reads not_computable' 200 \
    '[v["verdict"] for v in next(r for r in d if r["id"] == env["C_EXP"])["verdicts"]] == ["not_computable"]'
fi

# ---------------------------------------------------------------------------
section 'Re-score one run of A: a new results revision, one more verdict entry'
# ---------------------------------------------------------------------------

export A_RESCORE_RUN
if need 're-score one run of A' "$A_EXP" "$A_RESCORE_RUN"; then
  REV_BEFORE=''
  [ "$DOCKER" = 1 ] && REV_BEFORE="$(revisions "$A_EXP")"
  # The live stream, from before the re-score until its verdict entry.
  curl -sS -N --max-time "$RUN_TIMEOUT" "$BASE_URL/experiments/$A_EXP/events" >"$WORK/events.txt" 2>/dev/null &
  SSE_PID=$!
  sleep 2
  send_json POST "/runs/$A_RESCORE_RUN/rescore"
  check 'POST /runs/:id/rescore (west, with-skill, rep 1) -> generation 2' 200 \
    'd["status"] == "scored" and d["evaluation"]["generation"] == 2 and d["evaluation"]["cause"] == "rescore" and not d["joinedPending"]' \
    '"evaluation {evaluationId} gen {generation} {status}".format_map(d["evaluation"])'
  if wait_for "/experiments/$A_EXP" 'len(d["verdicts"][0]["history"]) == 2' "$RUN_TIMEOUT"; then
    check '  a second entry once it publishes: cause rescore, "1 run re-scored"' 200 \
      'd["status"] == "completed" and [(h["cause"], h["verdict"], h["note"], h["delta"], h["lo"], h["hi"]) for h in d["verdicts"][0]["history"]] == [("initial", "better", None, 0.75, 0.25, 1.0), ("rescore", "better", "1 run re-scored", 0.75, 0.25, 1.0)] and d["verdicts"][0]["verdict"] == "better"' \
      '" · ".join("{cause} {verdict} {note}".format_map(h) for h in d["verdicts"][0]["history"])'
  else
    fail '  a second entry once it publishes: cause rescore, "1 run re-scored"' "$(jv 'json.dumps(d["verdicts"][0]["history"])' 2>/dev/null)"
  fi
  cp "$BODY" "$WORK/a-detail.json"
  request GET "/runs/$A_RESCORE_RUN"
  check '  the run: generation 2 current, the same results' 200 \
    'd["status"] == "scored" and d["evaluation"]["generation"] == 2 and d["evaluation"]["pending"] is None and sorted((s["key"], s["status"]) for s in d["scores"]) == [("note", "failed"), ("total", "passed")]' \
    '", ".join("{} {}".format(s["key"], s["status"]) for s in d["scores"])'
  compare "$A_EXP"
  cp "$BODY" "$WORK/a-after.json"
  check '  the comparison at the new revision: still better, the same figures' 200 \
    'stats(d) == ("better", 0.75, 0.25, 1.0) and d["filterCounts"]["improved"] == 3 and d["progress"] == {"scored": 24, "total": 24} and d["rows"] == json.load(open(env["WORK"] + "/a-primary.json"))["rows"]' \
    '"Δ {observedDelta:+} [{lo:+}, {hi:+}] {verdict}".format_map(d["statistics"])'
  if [ "$DOCKER" = 1 ]; then
    REV_AFTER="$(revisions "$A_EXP")"
    LAST_REV="$(psql_ro "select verdict_history->-1->>'results_revision' from experiments where id = '$A_EXP'")"
    set -- $REV_BEFORE
    B_RESULTS="${1:-}" B_VERDICT="${2:-}" B_LEN="${3:-}"
    set -- $REV_AFTER
    if [ -n "$B_RESULTS" ] && [ "${1:-0}" -gt "$B_RESULTS" ] && [ "$B_VERDICT" = "$B_RESULTS" ] && [ "${2:-}" = "${1:-}" ] && [ "$LAST_REV" = "${1:-}" ] && [ "$B_LEN" = 1 ] && [ "${3:-}" = 2 ]; then
      pass '  stored: results revision moved, one entry appended at it' "before $REV_BEFORE · after $REV_AFTER (results verdict entries) · last entry at revision $LAST_REV"
    else
      fail '  stored: results revision moved, one entry appended at it' "before '$REV_BEFORE' · after '$REV_AFTER' · last entry at revision '$LAST_REV'"
    fi
  fi
  # A few more polls of the stream, then what it sent.
  sleep 3
  kill "$SSE_PID" 2>/dev/null
  wait "$SSE_PID" 2>/dev/null
  SSE_PID=''
  python3 - "$WORK/events.txt" >"$WORK/events.json" <<'PY'
import json, sys
events, kind = [], None
for text in open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines():
    if text.startswith('event: '):
        kind = text[7:]
    elif text.startswith('data: ') and kind:
        events.append(json.loads(text[6:]))
        kind = None
print(json.dumps(events))
PY
  # The stream is polled every second: a re-score that publishes within one
  # poll shows only generation 2, else generation 1 pending first.
  check_file '  live stream: a run event with generation 2, nothing pending' "$WORK/events.json" \
    '[(e["generation"], e["rescorePending"]) for e in d if e["type"] == "run" and e["runId"] == env["A_RESCORE_RUN"]] in ([(2, False)], [(1, True), (2, False)])' \
    '" -> ".join("gen {} pending {}".format(e["generation"], e["rescorePending"]) for e in d if e["type"] == "run" and e["runId"] == env["A_RESCORE_RUN"])'
  check_file '  live stream: an experiment event for the verdict change' "$WORK/events.json" \
    '[e for e in d if e["type"] == "experiment"][-1]["verdictUpdatedAt"] == json.load(open(env["WORK"] + "/a-detail.json"))["verdicts"][0]["history"][1]["at"] and [e for e in d if e["type"] == "experiment"][-1]["status"] == "completed" and [v["verdict"] for v in [e for e in d if e["type"] == "experiment"][-1]["verdicts"]] == ["better"] and len([e for e in d if e["type"] == "experiment"]) >= 2' \
    '"{} experiment events; the last: verdictUpdatedAt {}".format(len([e for e in d if e["type"] == "experiment"]), [e for e in d if e["type"] == "experiment"][-1]["verdictUpdatedAt"])'
fi

if [ "$DOCKER" = 1 ] && [ -n "$A_EXP" ] && [ -n "$B_EXP" ] && [ -n "$C_EXP" ]; then
  psql_ro "select json_agg(json_build_object('id', id, 'results', results_revision, 'verdict', verdict_revision, 'history', verdict_history)) from experiments where id in ('$A_EXP', '$B_EXP', '$C_EXP')" >"$WORK/history.json"
  # By experiment: [(cause, verdict, key, the entry's results revision)], and its revisions.
  python3 - "$WORK/history.json" >"$WORK/stored.json" <<'PY2'
import json, os, sys
rows = {x['id']: x for x in json.load(open(sys.argv[1]))}
names = {os.environ['A_EXP']: 'A', os.environ['B_EXP']: 'B', os.environ['C_EXP']: 'C'}
print(json.dumps({names[i]: {'entries': [[h['cause'], h['verdict'], h['key'], h['results_revision']] for h in x['history']],
                             'results': x['results'], 'verdict': x['verdict']} for i, x in rows.items()}))
PY2
  check_file 'stored verdict history: one entry per candidate per results revision' "$WORK/stored.json" \
    'all(x["results"] == x["verdict"] == x["entries"][-1][3] for x in d.values()) and [e[:3] for e in d["A"]["entries"]] == [["initial", "better", "primary"], ["rescore", "better", "primary"]] and d["A"]["entries"][0][3] < d["A"]["entries"][1][3] and [e[:3] for e in d["B"]["entries"]] == [["initial", "inconclusive", "primary"]] and [e[:3] for e in d["C"]["entries"]] == [["initial", "not_computable", "primary"]]' \
    '"; ".join("{} {}".format(k, " ".join("{}:{}@{}".format(e[0], e[1], e[3]) for e in v["entries"])) for k, v in sorted(d.items()))'
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
