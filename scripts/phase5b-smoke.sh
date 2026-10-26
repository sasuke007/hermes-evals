#!/usr/bin/env bash
# Phase 5b smoke test: suite authoring (plan 4.6) on a running Hermes Evals
# stack, through the API as the web app calls it, with real trial containers
# and real Hermes against the scripted mock model, printing one
# PASS/FAIL/SKIP line per step. It covers the API side of Flow E and the
# rest of plan 17's Phase 5b exit:
#
# - Flow E from nothing (zz-smoke-<stamp>-flowe): a new suite, a blank task
#   with an answer check (readiness clean in the API, Try it on a pasted
#   reply), a blank task with a file check and an expected workspace (its
#   self-check in the worker: passes on expected/, fails on the fixtures),
#   uploads, refused writes under verify/, Review, Save as v1, then an
#   experiment on v1 with two mock configurations (file and file-terminal);
# - an edit saved as v2 changing one line of task.yaml; both save conflicts
#   (a file edited on disk without a reload: disk_changed; a version moved
#   by a reload: version_moved), each combined with rebase and saved; tasks
#   imported from a CSV (and a row whose key needs a fix refused with 422);
#   v1 downloaded as a zip and compared byte for byte; a task restored from
#   v1 and saved;
# - a suite from a .zip: a copy of tools-v1 with its verify/ scripts listed
#   by path, size and hash, refused without "I trust these scripts",
#   imported with it under zz-smoke-<stamp>-zip and saved as v1 byte for
#   byte; zips with a link, a `..` path and an absolute path refused;
# - the round trip of plan 4.6: a copy of each committed suite
#   (zz-smoke-<stamp>-rt-<suite>, its suite.yaml renamed) opened as a draft
#   and saved with no edit reports `unchanged` and touches no file;
# - verifier scripts in their own container (R7): the containers the zip's
#   save and the copies' loads start, through docker-guard under its
#   verifier policy, each on the trial image with no network, a read-only
#   root and inputs, no capability, uid 10000 and no environment but PATH
#   beyond the image's own; none left behind;
# - Reload all as one job per directory with each folder's progress.
#
#   scripts/phase5b-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase5b-smoke.sh  # through nginx
#
# The stack needs the Phase 5b images (docker-guard, api, worker and web
# rebuilt together) and the mock model (profile `test`) with
# scripts/phase5b-mock-scripts.json among MOCK_SCRIPTS: its two scripts
# answer the Flow E tasks by their prompts' first line (the answer task with
# the reference, the file task with a terminal call that writes summary.csv,
# so the file configuration fails it and file-terminal passes). Compose
# reads MOCK_SCRIPTS from the shell before .env, so no file changes:
#
#   MOCK_SCRIPTS="$(python3 -c 'import glob, json; print(json.dumps([s for f in sorted(glob.glob("scripts/*mock-scripts.json")) for s in json.load(open(f))]))')" \
#     docker compose --profile test up -d
#
# Every configuration uses provider `custom` with base URL
# http://mock-model:8090/v1 and model mock/scripted, which config/prices.yaml
# prices at 0: no real provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl and python3 (3.8+, no package beyond the
# standard library). Exits 0 only when no step failed.
# It writes to the stack it tests and into SUITES_DIR (the worker's ./suites
# mount), so point it at a development stack only. Every name it creates
# starts with smoke-<UTC timestamp> or zz-smoke-<UTC timestamp>, so it can
# run again and again; it never writes to the committed suites (it reads
# tools-v1 and copies the five), and its suite folders are removed at the
# end and reloaded, which leaves their suite_sources rows `missing`.
# Configurations and the experiment stay (there are no delete endpoints).
# On Colima, export DOCKER_CONTEXT=colima so the docker checks run.
#
# Settings (environment):
#   BASE_URL      API base URL (default http://localhost:3000/api)
#   SUITES_DIR    host directory the worker mounts as its suites (default <repo>/suites)
#   SMOKE_DOCKER  auto (default) | 0: also check, read-only through docker, the mock's
#                 scripts, the mounts, migration 0009 and the verifier containers
#   TRIAL_IMAGE   the trial image verifier containers run on (default hermes-evals/trial:v0.22.4-4d04303)
#   RUN_TIMEOUT   seconds the experiment may take (default 600)
#   CURL_TIMEOUT  seconds per request (default 180)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
TRIAL_IMAGE="${TRIAL_IMAGE:-hermes-evals/trial:v0.22.4-4d04303}"
RUN_TIMEOUT="${RUN_TIMEOUT:-600}"
CURL_TIMEOUT="${CURL_TIMEOUT:-180}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
FOLDER="zz-smoke-$STAMP-flowe"
ZIPPED="zz-smoke-$STAMP-zip"
COMMITTED='invoices-v1 mcp-v1 memory-v1 knowledge-v1 tools-v1'
CHECKS="$REPO_DIR/scripts/phase5b-smoke-checks.py"
export REPO_DIR SUITES_DIR FOLDER ZIPPED CHECKS TRIAL_IMAGE

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "phase5b-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase5b-smoke.XXXXXX")"
export WORK
BODY="$WORK/body"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
EVENTS_PID=''
# The suite folders this run made in SUITES_DIR, removed at the end.
MADE=''
cleanup_folders() {
  local name
  for name in $MADE; do
    case "$name" in zz-smoke-"$STAMP"-*) rm -rf "${SUITES_DIR:?}/$name" ;; esac
  done
}
# The background `docker events` reader of the verifier step, and its children.
stop_events() {
  [ -n "$EVENTS_PID" ] || return 0
  pkill -P "$EVENTS_PID" 2>/dev/null
  kill "$EVENTS_PID" 2>/dev/null
  EVENTS_PID=''
}
trap 'stop_events; cleanup_folders; rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------------------
# Helpers (as in phase6b-smoke.sh)
# ---------------------------------------------------------------------------

# request METHOD PATH [curl args...]: the body lands in $BODY and the status
# in $STATUS (000 when curl itself failed). State-changing requests carry
# X-Requested-With, as the web app's do.
request() {
  local method="$1" path="$2"
  shift 2
  if [ "$method" = GET ]; then
    STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time "$CURL_TIMEOUT" \
      "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
  else
    STATUS="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time "$CURL_TIMEOUT" -X "$method" \
      -H 'X-Requested-With: phase5b-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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
# response) as `d`, with `env`, `json`, `raw` and the helpers of
# scripts/phase5b-smoke-checks.py in scope.
jv() {
  python3 - "$1" "${2:-$BODY}" <<'PY'
import json, os, sys
with open(os.environ['CHECKS'], encoding='utf-8') as f:
    exec(compile(f.read().split("if __name__ == '__main__':")[0], os.environ['CHECKS'], 'exec'))
expr, path = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8', errors='replace') as f:
    raw = f.read()
try:
    d = json.loads(raw)
except ValueError:
    d = None
try:
    value = eval(expr, dict(globals(), d=d, raw=raw))
except Exception as exc:
    print('{}: {}'.format(type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
print(value if isinstance(value, str) else json.dumps(value))
PY
}
helper() { python3 "$CHECKS" "$@"; }

line() { printf '%-5s %-78s %s\n' "$1" "$2" "$3"; }
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
    fail "$name" "check is $result $(tr '\n' ' ' <"$WORK/jv.err" | cut -c1-160)· $(if [ -n "$detail" ]; then jv "$detail" 2>/dev/null | cut -c1-300; else snippet; fi)"
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

# wait_for PATH EXPR TIMEOUT: polls GET PATH every 2 s until EXPR is true over its body.
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

D="/suites/$FOLDER/draft"
# upload KEY KIND FILE [PATH]: one file into a draft task, as the drop zone sends it.
upload() {
  helper file "$3" >"$WORK/$3"
  if [ $# -ge 4 ]; then
    request POST "/suites/$FOLDER/draft/tasks/$1/files" -F "kind=$2" -F "path=$4" -F "file=@$WORK/$3;filename=$3"
  else
    request POST "/suites/$FOLDER/draft/tasks/$1/files" -F "kind=$2" -F "file=@$WORK/$3;filename=$3"
  fi
}
# settle: after a write to SUITES_DIR from this host and before the worker reads it.
# On macOS the worker sees SUITES_DIR through the Docker VM's file sharing, which
# may serve a folder's old entries for about a second (a removed folder still
# listed, empty).
settle() { sleep 2; }
# save FOLDER: POST …/draft/save; the result stays in $BODY.
save() { send_json POST "/suites/$1/draft/save" '{}'; }

# Docker checks run when the stack is this repository's Compose project here.
DOCKER=0
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null &&
  (cd "$REPO_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx worker); then
  DOCKER=1
fi
dc() { (cd "$REPO_DIR" && docker compose "$@"); }

printf 'Phase 5b smoke · %s · stamp %s · suites dir %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$SUITES_DIR" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

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
request GET /suites/drafts
check 'GET /suites/drafts answers the open drafts' 200 'isinstance(d, list)' '"{} open".format(len(d))'

if [ "$DOCKER" = 1 ]; then
  dc exec -T mock-model printenv MOCK_SCRIPTS >"$WORK/mock-scripts.json" 2>/dev/null
  check_file 'the mock holds every scripts/*mock-scripts.json, phase5b included' "$WORK/mock-scripts.json" \
    'all(s["match"] in {x["match"] for x in d} for f in __import__("glob").glob(env["REPO_DIR"] + "/scripts/*mock-scripts.json") for s in json.load(open(f)))' \
    '"{} scripts".format(len(d))'
  docker inspect "$(dc ps -q worker)" "$(dc ps -q api)" >"$WORK/mounts.json" 2>/dev/null
  check_file "the worker mounts ./suites read-write at /data/suites; the api has no suites mount" "$WORK/mounts.json" \
    'any(m["Destination"] == "/data/suites" and m["RW"] and os.path.realpath(m["Source"]).endswith("/suites") for m in d[0]["Mounts"]) and not any(m["Destination"].startswith("/data/suites") for m in d[1]["Mounts"])' \
    '"worker: " + ", ".join("{} {}".format(m["Destination"], "rw" if m["RW"] else "ro") for m in d[0]["Mounts"] if "suites" in m["Destination"])'
  SQL='select json_agg(hash order by id) from drizzle.__drizzle_migrations'
  dc exec -T postgres psql -U hermes -d hermes_evals -Atc "$SQL" >"$WORK/migrations.json" 2>/dev/null
  check_file 'migration 0009 (draft tables) is applied' "$WORK/migrations.json" \
    'd[-1] == sha(open(env["REPO_DIR"] + "/apps/api/drizzle/0009_phase5b_authoring.sql", "rb").read())' \
    '"{} migrations, the last 0009 ({})".format(len(d), d[-1][:12])'
else
  skip 'docker checks: mock scripts, mounts, migration 0009' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section "Flow E: $FOLDER from nothing, through the draft API"
# ---------------------------------------------------------------------------

MADE="$MADE $FOLDER"
send_json POST /suites/drafts "{\"name\":\"$FOLDER\",\"versionLabel\":\"0.1\",\"description\":\"Phase 5b smoke: Flow E.\",\"from\":{\"kind\":\"empty\"}}"
check 'POST /suites/drafts: a new suite opens as an empty draft' 201 \
  'd["folder"] == env["FOLDER"] and d["origin"] == "empty" and d["base"] is None and d["nextVersion"] == 1 and [p["code"] for p in d["problems"]] == ["no_tasks"]' \
  'd["problems"][0]["message"]'
send_json POST /suites/drafts "{\"name\":\"$FOLDER\",\"versionLabel\":\"0.1\",\"from\":{\"kind\":\"empty\"}}"
check '  the name is held: a second new suite of that name is refused' 409 'True' 'd["message"]'

send_json POST "$D/tasks" '{"kind":"blank","key":"unpaid_total"}'
check 'blank task unpaid_total' 201 'd["keys"] == ["unpaid_total"]'
send_json PUT "$D/tasks/unpaid_total" "$(helper body unpaid)"
check '  its form, prompt and reference' 200 'd["state"] == "added" and d["prompt"] == UNPAID_PROMPT'
upload unpaid_total fixture invoices.csv
check '  invoices.csv uploaded: an answer check self-checks in the API, ready' 201 \
  'd["readiness"]["summary"] == "ready" and ["fixtures/invoices.csv", "fixture"] in [[f["path"], f["kind"]] for f in d["files"]]' \
  'd["readiness"]["summary"] + " · " + ", ".join(f["path"] for f in d["files"])'
check '  task.yaml lists its first check in block style, as the committed suites do' 201 \
  '"\nverification:\n  - key: answer\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n" in d["taskYaml"]'
send_json POST "$D/tasks/unpaid_total/try" '{"key":"answer","reply":"Rows 2 and 3: 80.25 + 19.25.\n\n```json\n{ \"unpaid_total\": 99.5 }\n```"}'
check '  Try it on a pasted reply: extracted, 99.5, passed' 200 \
  'd["against"] == "reply" and d["extraction"]["status"] == "found" and d["value"] == "99.5" and d["status"] == "passed"' \
  '"{status} · {comment}".format_map(d)'
send_json POST "$D/tasks/unpaid_total/try" '{"key":"answer","reply":"```json\n{ \"unpaid_total\": 100 }\n```"}'
check '  Try it on a wrong reply: failed' 200 'd["status"] == "failed"' '"{status} · {comment}".format_map(d)'

send_json POST "$D/tasks" '{"kind":"blank","key":"vendor_summary"}'
check 'blank task vendor_summary' 201 'd["keys"] == ["vendor_summary"]'
send_json PUT "$D/tasks/vendor_summary" "$(helper body vendor-nopath)"
check '  a File check without its path: readiness asks for it in plain words' 200 \
  '[i["message"] for i in d["readiness"]["issues"] if i["rule"] == "check_settings"] == ["Add the file path."]'
send_json PUT "$D/tasks/vendor_summary" "$(helper body vendor)"
check '  its form with the file check and the expected workspace' 200 'd["form"]["expectedWorkspace"] == "expected"'
upload vendor_summary fixture ledger.csv
check '  ledger.csv uploaded' 201 '"fixtures/ledger.csv" in [f["path"] for f in d["files"]]'
upload vendor_summary expected summary.csv
check '  expected/summary.csv uploaded: no problem, the self-check waits for the worker' 201 \
  '"expected/summary.csv" in [f["path"] for f in d["files"]] and d["readiness"]["counts"]["problems"] == 0 and d["readiness"]["needsWorker"] and next(r for r in d["readiness"]["rules"] if r["rule"] == "self_check")["status"] == "pending"'

send_json PATCH "$D/tasks/vendor_summary/files/fixtures%2Fledger.csv" '{"path":"verify/ledger.csv"}'
check 'verify/ refused (R7): a move into verify/' 400 'True' 'd["message"]'
send_json PUT "$D/tasks/vendor_summary" '{"rubrics":[{"path":"verify/rubric.md","text":"x"}]}'
check '  a rubric under verify/' 400 'True' 'd["message"]'
upload vendor_summary fixture ledger.csv ../verify/ledger.csv
check '  an upload to ../verify/' 400 'True' 'd["message"]'

send_json POST "$D/tasks/vendor_summary/self-check" '{}'
check "the file check's self-check in the worker: passes on expected/, fails on the fixtures" 200 \
  'd["status"] == "passed" and d["current"] and [[r["key"], r["mode"], r["expect"], r["status"]] for r in d["results"]] == [["summary_csv", "workspace", "pass", "passed"], ["summary_csv", "workspace", "fail", "failed"]]' \
  '"{} in {} ms".format(d["status"], d["durationMs"])'
request GET "$D"
check 'the draft: no problem, two tasks added' 200 \
  'd["problems"] == [] and [(c["kind"], c["key"]) for c in d["changes"]] == [("added", "unpaid_total"), ("added", "vendor_summary")]'
request GET "$D/review"
check 'Review: nothing invalid, suite.yaml and both folders written' 200 \
  'd["invalid"] == [] and "./suites/{}/suite.yaml".format(env["FOLDER"]) in [w["path"] for w in d["writes"]]' \
  '"{} writes".format(len(d["writes"]))'
save "$FOLDER"
check 'Save as v1: created, 2 tasks, 2 valid' 200 \
  'd["outcome"] == "created" and d["suite"]["versionNumber"] == 1 and d["taskCount"] == 2 and d["validCount"] == 2' \
  '"v{} · {} tasks, {} valid".format(d["suite"]["versionNumber"], d["taskCount"], d["validCount"])'
V1_ID="$(jv 'd["suite"]["suiteId"]' 2>/dev/null)"
request GET "$D"
check '  the draft is gone' 404 'True'
if [ -d "$SUITES_DIR/$FOLDER" ]; then
  cp -R "$SUITES_DIR/$FOLDER" "$WORK/v1"
  helper tree "$SUITES_DIR/$FOLDER" >"$WORK/v1.json"
  check_file "  ./suites/$FOLDER on disk: ten files, every text as typed, no staging folder left" "$WORK/v1.json" \
    'sorted(d) == ["suite.yaml", "unpaid_total/fixtures/invoices.csv", "unpaid_total/prompt.md", "unpaid_total/reference.json", "unpaid_total/task.yaml", "vendor_summary/expected/summary.csv", "vendor_summary/fixtures/ledger.csv", "vendor_summary/prompt.md", "vendor_summary/reference.json", "vendor_summary/task.yaml"] and open(env["WORK"] + "/v1/unpaid_total/prompt.md").read() == UNPAID_PROMPT and not [n for n in os.listdir(env["SUITES_DIR"]) if n.startswith(".draft-")]'
else
  fail "  ./suites/$FOLDER on disk" 'the folder is missing'
fi

# ---------------------------------------------------------------------------
section 'An experiment on v1: file against file-terminal, on the mock'
# ---------------------------------------------------------------------------

# config ARM TOOLSETS: POST /configurations smoke-<stamp>-ARM; sets VERSION_ID.
config() {
  VERSION_ID=''
  send_json POST /configurations "$(printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":[%s],"memoryEnabled":false,"skillIds":[],"skillLoading":"preload","documentIds":[],"mcpServerVersionIds":[],"maxTurns":10,"timeBudgetS":180,"duplicatedFromVersionId":null}' "$PREFIX-$1" "$2")"
  check "POST /configurations $PREFIX-$1" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)' || return 0
  VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
}
config file '"file"' && FILE_ARM="$VERSION_ID"
config file-terminal '"file","terminal"' && TERM_ARM="$VERSION_ID"
EXP=''
if need 'POST /experiments on v1' "$V1_ID" "${FILE_ARM:-}" "${TERM_ARM:-}"; then
  request GET /experiments/new-options
  cp "$BODY" "$WORK/options.json"
  BODY_JSON="$(python3 - "$WORK/options.json" "$V1_ID" "$PREFIX" "$FILE_ARM" "$TERM_ARM" <<'PY'
import json, sys
options, suite, prefix, base, cand = sys.argv[1:6]
h = {c['versionId']: c['configHash'] for c in json.load(open(options))['configurations']}
print(json.dumps({'name': prefix + '-flowe-v1', 'description': 'phase5b-smoke: Flow E on v1', 'suiteId': suite,
                  'taskKeys': ['unpaid_total', 'vendor_summary'], 'baselineVersionId': base,
                  'candidateVersionIds': [cand], 'repetitions': 2, 'concurrency': 3, 'spendCeilingUsd': None,
                  'timeBudgetOverrideS': None, 'expectedConfigHashes': {base: h[base], cand: h[cand]}}))
PY
  )"
  send_json POST /experiments "$BODY_JSON"
  check 'POST /experiments: 2 tasks x 2 configurations x 2 repetitions on v1' 201 'bool(d["id"])' '"experiment " + d["id"]'
  EXP="$(jv 'd["id"]' 2>/dev/null)"
fi
if need 'the experiment completes' "$EXP"; then
  if wait_for "/experiments/$EXP" 'd["status"] in ("completed", "failed", "cancelled")' "$RUN_TIMEOUT"; then
    check 'the experiment completes, 8 of 8 runs scored' 200 \
      'd["status"] == "completed" and d["counts"]["scored"] == 8 and d["totalRuns"] == 8' '"{} in {} s".format(d["status"], d["elapsedS"])'
    request GET "/experiments/$EXP/runs"
    check '  unpaid_total passes on both; vendor_summary fails without the terminal, passes with it' 200 \
      'sorted({(r["taskKey"], r["configuration"]["name"].split("-", 2)[2], r["primaryScore"]["status"]) for r in d["rows"]}) == [("unpaid_total", "file", "passed"), ("unpaid_total", "file-terminal", "passed"), ("vendor_summary", "file", "failed"), ("vendor_summary", "file-terminal", "passed")]' \
      '"; ".join(sorted("{} {} {}".format(r["taskKey"], r["configuration"]["name"].split("-", 2)[2], r["primaryScore"]["status"]) for r in d["rows"]))'
  else
    fail 'the experiment completes, 8 of 8 runs scored' "still $(jv 'd["status"]' 2>/dev/null) after ${RUN_TIMEOUT} s"
  fi
fi

# ---------------------------------------------------------------------------
section 'An edit saved as v2; the two conflicts, each combined'
# ---------------------------------------------------------------------------

send_json POST "$D" '{}'
check 'POST …/draft: a draft of v1, every task unchanged' 201 \
  'd["base"]["versionNumber"] == 1 and d["changes"] == [] and {t["state"] for t in d["tasks"]} == {"unchanged"}'
DRAFT_ID="$(jv 'd["id"]' 2>/dev/null)"
send_json POST "$D" '{}'
DRAFT_ID="$DRAFT_ID" check '  opening it again answers the open draft' 200 'd["id"] == env["DRAFT_ID"]'
request GET "$D/tasks/unpaid_total"
cp "$BODY" "$WORK/unpaid.json"
REV="$(jv 'd["revision"]' 2>/dev/null)"
send_json PUT "$D/tasks/unpaid_total" "$(jv 'json.dumps({"form": dict(d["form"], maxTurns=12), "revision": d["revision"]})' "$WORK/unpaid.json")"
check '  the form: max turns 12' 200 'd["state"] == "changed"'
send_json PUT "$D/tasks/unpaid_total" "{\"prompt\":\"x\",\"revision\":${REV:-0}}"
check '  an edit on a stale revision is refused' 409 'True' 'd["message"]'
save "$FOLDER"
check 'Save as v2: unpaid_total changed' 200 \
  'd["outcome"] == "created" and d["suite"]["versionNumber"] == 2 and d["changes"]["changed"] == ["unpaid_total"]'
check_file '  task.yaml changed in one line, every other file of v1 untouched' "$WORK/v1.json" \
  'lines_changed(env["WORK"] + "/v1/unpaid_total/task.yaml", env["SUITES_DIR"] + "/" + env["FOLDER"] + "/unpaid_total/task.yaml") == ["  max_turns: 12"] and all(tree(env["SUITES_DIR"] + "/" + env["FOLDER"])[p] == h for p, h in d.items() if p not in ("unpaid_total/task.yaml", "suite.yaml"))'

PROMPT_FILE="$SUITES_DIR/$FOLDER/unpaid_total/prompt.md"
send_json POST "$D" '{}'
check 'a draft of v2' 201 'd["base"]["versionNumber"] == 2'
send_json PUT "$D/tasks/unpaid_total" "$(python3 -c 'import json, sys; print(json.dumps({"prompt": open(sys.argv[1]).read().replace("`unpaid`.", "`unpaid`. Show your working.", 1)}))' "$PROMPT_FILE")"
check '  my prompt edit' 200 '"Show your working." in d["prompt"]'
cp "$BODY" "$WORK/mine.json"
python3 -c 'import sys; p = sys.argv[1]; s = open(p).read(); open(p, "w").write(s.replace("`unpaid`.", "`unpaid`. Round to the cent.", 1))' "$PROMPT_FILE"
settle
save "$FOLDER"
check 'save over prompt.md edited on disk without a reload: 409 disk_changed, both changed unpaid_total' 409 \
  'd["conflict"]["cause"] == "disk_changed" and d["conflict"]["baseVersion"] == 2 and d["conflict"]["current"]["versionNumber"] == 3 and d["conflict"]["overlap"] == ["unpaid_total"]' \
  'd["message"]'
grep -q 'Round to the cent.' "$PROMPT_FILE" && pass '  nothing of the draft reached the disk' || fail '  nothing of the draft reached the disk' 'the hand edit is gone'
send_json POST "$D/rebase" '{"onto":3,"choices":[{"key":"unpaid_total","keep":"mine"}]}'
check '  Combine onto v3, keeping my version' 200 'd["base"]["versionNumber"] == 3 and d["conflict"] is None'
save "$FOLDER"
check '  saved as v4, my prompt on disk' 200 \
  'd["suite"]["versionNumber"] == 4 and open(env["SUITES_DIR"] + "/" + env["FOLDER"] + "/unpaid_total/prompt.md").read() == jfile(env["WORK"] + "/mine.json")["prompt"]'

send_json POST "$D" '{}'
check 'a draft of v4' 201 'd["base"]["versionNumber"] == 4'
request GET "$D/tasks/vendor_summary"
send_json PUT "$D/tasks/vendor_summary" "$(jv 'json.dumps({"form": dict(d["form"], maxTurns=12)})')"
check '  vendor_summary: max turns 12' 200 'd["state"] == "changed"'
printf 'Thank you.\n' >>"$PROMPT_FILE"
settle
send_json POST /suites/reload "{\"path\":\"$FOLDER\"}"
check '  a hand edit of unpaid_total reloaded: v5' 200 'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 5'
request GET "$D"
check '  the draft shows the conflict: version_moved, nothing overlaps' 200 \
  'd["conflict"]["cause"] == "version_moved" and d["conflict"]["baseVersion"] == 4 and d["conflict"]["current"]["versionNumber"] == 5 and d["conflict"]["overlap"] == [] and d["conflict"]["draftKeys"] == ["vendor_summary"]'
save "$FOLDER"
check '  its save answers 409 version_moved' 409 'd["conflict"]["cause"] == "version_moved" and d["conflict"]["current"]["versionNumber"] == 5'
send_json POST "$D/rebase" '{"onto":5,"choices":[]}'
check '  Combine onto v5' 200 'd["base"]["versionNumber"] == 5 and d["conflict"] is None'
save "$FOLDER"
check '  saved as v6: the hand edit and max turns 12 both on disk' 200 \
  'd["suite"]["versionNumber"] == 6 and open(env["SUITES_DIR"] + "/" + env["FOLDER"] + "/unpaid_total/prompt.md").read().endswith("Thank you.\n") and "max_turns: 12" in open(env["SUITES_DIR"] + "/" + env["FOLDER"] + "/vendor_summary/task.yaml").read()'

# ---------------------------------------------------------------------------
section 'Tasks from a CSV; v1 downloaded; a task restored from v1'
# ---------------------------------------------------------------------------

send_json POST "$D" '{}'
check 'a draft of v6' 201 'd["base"]["versionNumber"] == 6'
helper file questions.csv >"$WORK/questions.csv"
helper file bad-keys.csv >"$WORK/bad-keys.csv"
SETTINGS="$(helper settings)"
request POST "$D/import/validate" -F "file=@$WORK/questions.csv;filename=questions.csv"
check 'POST …/import/validate: questions.csv read, 2 rows, 3 columns' 200 \
  'd["problems"] == [] and d["file"]["format"] == "csv" and d["file"]["rowCount"] == 2 and [c["name"] for c in d["file"]["columns"]] == ["key", "question", "answer"]'
request POST "$D/import/validate" -F "file=@$WORK/questions.csv;filename=questions.csv" --form-string "settings=$SETTINGS"
check '  mapped (key, prompt, value at total; workspace and checks of unpaid_total): 2 rows ready' 200 \
  'd["preview"]["addCount"] == 2 and d["preview"]["fixCount"] == 0 and [[r["key"], r["referenceValue"], r["readiness"]] for r in d["preview"]["rows"]] == [["paid_total", "160", "ready"], ["all_total", "259.5", "ready"]]'
request POST "$D/import" -F "file=@$WORK/bad-keys.csv;filename=bad-keys.csv" --form-string "settings=$SETTINGS"
check '  a row whose key is not a folder name is refused: 422 with the preview' 422 \
  'd["preview"]["fixCount"] == 1 and d["preview"]["rows"][0]["needsFix"]' 'd["preview"]["rows"][0]["problems"][0]["message"]'
request POST "$D/import" -F "file=@$WORK/questions.csv;filename=questions.csv" --form-string "settings=$SETTINGS"
check '  POST …/import: 2 tasks added' 201 'd["added"] == ["paid_total", "all_total"]'
request GET "$D/tasks/paid_total"
check '  paid_total: { "total": 160 }, the answer paragraph, invoices.csv' 200 \
  'json.loads(d["reference"]) == {"total": 160} and ANSWER_LEAD in d["prompt"] and "fixtures/invoices.csv" in [f["path"] for f in d["files"]]'
save "$FOLDER"
check '  saved as v7: 4 tasks, 4 valid' 200 \
  'd["suite"]["versionNumber"] == 7 and d["taskCount"] == 4 and d["validCount"] == 4 and d["changes"]["added"] == ["paid_total", "all_total"]'

STATUS="$(curl -sS -o "$WORK/v1.zip" -D "$WORK/v1.headers" -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$BASE_URL/suites/$FOLDER/versions/1/zip" 2>"$WORK/curl.err")" || STATUS=000
if [ "$STATUS" = 200 ] && grep -qi '^content-type: application/zip' "$WORK/v1.headers" &&
  grep -qi "^content-disposition:.*filename=\"$FOLDER-v1.zip\"" "$WORK/v1.headers"; then
  # suite.yaml is written anew from the stored version (its text is not kept); the rest are the blobs.
  check_file "GET …/versions/1/zip: $FOLDER-v1.zip holds v1's files byte for byte" "$WORK/v1.json" \
    'sorted(zip_tree(env["WORK"] + "/v1.zip")) == sorted(env["FOLDER"] + "/" + p for p in d) and all(zip_tree(env["WORK"] + "/v1.zip")[env["FOLDER"] + "/" + p] == h for p, h in d.items() if p != "suite.yaml") and zip_text(env["WORK"] + "/v1.zip", env["FOLDER"] + "/suite.yaml") == open(env["WORK"] + "/v1/suite.yaml").read()' \
    '"{} files, {} bytes".format(len(zip_tree(env["WORK"] + "/v1.zip")), os.path.getsize(env["WORK"] + "/v1.zip"))'
else
  fail "GET …/versions/1/zip: $FOLDER-v1.zip" "HTTP $STATUS $(head -c 200 "$WORK/v1.headers" | tr '\r\n' '  ')"
fi

send_json POST "$D" '{}'
check 'a draft of v7' 201 'd["base"]["versionNumber"] == 7'
send_json POST "$D/tasks" '{"kind":"restore","suiteVersion":1,"key":"unpaid_total"}'
check '  restore unpaid_total from v1' 201 \
  'd["keys"] == ["unpaid_total"] and any(c["kind"] == "restored" and c["key"] == "unpaid_total" and c["fromSuiteVersion"] == 1 for c in d["draft"]["changes"])'
save "$FOLDER"
check '  saved as v8: unpaid_total holds v1 files again' 200 \
  'd["suite"]["versionNumber"] == 8 and tree(env["SUITES_DIR"] + "/" + env["FOLDER"] + "/unpaid_total") == tree(env["WORK"] + "/v1/unpaid_total")'

# ---------------------------------------------------------------------------
section 'A suite from a .zip with verifier scripts (R7); the round trip of each committed suite'
# ---------------------------------------------------------------------------

# Verifier containers from here on: docker's create events, each inspected at once.
GUARD_FROM="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$DOCKER" = 1 ]; then
  mkdir -p "$WORK/verifiers"
  (docker events --filter type=container --filter event=create --format '{{.Actor.ID}} {{.Actor.Attributes.name}}' 2>/dev/null |
    while read -r id name; do
      case "$name" in hermes-evals-verify-*) docker inspect "$id" >"$WORK/verifiers/$name.json" 2>/dev/null & ;; esac
    done) &
  EVENTS_PID=$!
  disown "$EVENTS_PID" 2>/dev/null || true
fi

MADE="$MADE $ZIPPED"
helper zip "$SUITES_DIR/tools-v1" "$WORK/tools-v1.zip" tools-v1
request POST /suites/import/validate -F "file=@$WORK/tools-v1.zip;filename=tools-v1-copy.zip;type=application/zip"
cp "$BODY" "$WORK/zip-check.json"
check 'POST /suites/import/validate: a copy of tools-v1, its name taken, 6 tasks' 200 \
  'd["outcome"] == "name_taken" and d["nameTaken"]["path"] == "./suites/tools-v1" and d["suite"]["name"] == "tools-v1" and len(d["tasks"]) == 6 and bool(d["token"])' \
  '"suggested " + d["nameTaken"]["suggestion"]'
check '  "This suite contains code": every verify/ file with its size and sha256' 200 \
  'sorted((s["path"], s["sizeBytes"], s["sha256"]) for s in d["scripts"]) == sorted((p, os.path.getsize(env["SUITES_DIR"] + "/tools-v1/" + p), h) for p, h in tree(env["SUITES_DIR"] + "/tools-v1").items() if "/verify/" in p)' \
  '", ".join("{path} {sizeBytes} B {}".format(s["sha256"][:7], **s) for s in d["scripts"])'
TOKEN="$(jv 'd["token"]' "$WORK/zip-check.json" 2>/dev/null)"
send_json POST /suites/import "{\"token\":\"$TOKEN\",\"name\":\"$ZIPPED\",\"trustScripts\":false}"
check '  imported without "I trust these scripts": refused' 409 'd["message"] == "Confirm the verifier scripts first."' 'd["message"]'
send_json POST /suites/import "{\"token\":\"$TOKEN\",\"name\":\"$ZIPPED\",\"trustScripts\":true}"
check "  with it: the draft of $ZIPPED, every task added" 201 \
  'd["folder"] == env["ZIPPED"] and d["origin"] == "zip" and d["base"] is None and [t["state"] for t in d["tasks"]] == ["added"] * 6'
VERIFY_PATH='verify%2Fcheck_stock.py'
STATUS="$(curl -sS -o "$WORK/script.py" -w '%{http_code}' --max-time "$CURL_TIMEOUT" "$BASE_URL/suites/$ZIPPED/draft/tasks/reshape_json/files/$VERIFY_PATH")" || STATUS=000
if [ "$STATUS" = 200 ] && cmp -s "$WORK/script.py" "$SUITES_DIR/tools-v1/reshape_json/verify/check_stock.py"; then
  pass '  the script reads back byte for byte (shown, never written)'
else
  fail '  the script reads back byte for byte (shown, never written)' "HTTP $STATUS"
fi
request DELETE "/suites/$ZIPPED/draft/tasks/reshape_json/files/$VERIFY_PATH" -H 'Content-Type: application/json' --data-binary '{}'
check '  deleting it through the draft is refused' 400 'True' 'd["message"]'
save "$ZIPPED"
check "  Save as v1: 6 tasks, 6 valid, its verifier self-checked" 200 \
  'd["outcome"] == "created" and d["suite"]["versionNumber"] == 1 and d["taskCount"] == 6 and d["validCount"] == 6'
check_file "  every task file byte for byte as in tools-v1; suite.yaml names $ZIPPED" "$WORK/zip-check.json" \
  '{p: h for p, h in tree(env["SUITES_DIR"] + "/" + env["ZIPPED"]).items() if p != "suite.yaml"} == {p: h for p, h in tree(env["SUITES_DIR"] + "/tools-v1").items() if p != "suite.yaml"} and open(env["SUITES_DIR"] + "/" + env["ZIPPED"] + "/suite.yaml").read().startswith("name: " + env["ZIPPED"] + "\n")'
for KIND in link dotdot absolute; do
  helper bad-zip "$REPO_DIR/apps/api/test/fixtures/suites/complete" "$WORK/bad-$KIND.zip" "$KIND" 2>"$WORK/zip.err" || {
    fail "  a zip with a $KIND entry is refused" "$(head -c 200 "$WORK/zip.err")"
    continue
  }
  request POST /suites/import/validate -F "file=@$WORK/bad-$KIND.zip;filename=bad-$KIND.zip;type=application/zip"
  check "  a zip with a $KIND entry is refused, nothing stored" 200 \
    'd["outcome"] == "rejected" and d["token"] is None and len(d["problems"]) > 0' 'd["problems"][0]["title"] if d["problems"] else ""'
done

for SUITE in $COMMITTED; do
  COPY="zz-smoke-$STAMP-rt-$SUITE"
  MADE="$MADE $COPY"
  export COPY
  cp -R "$SUITES_DIR/$SUITE" "$SUITES_DIR/$COPY"
  python3 -c 'import sys; p = sys.argv[1]; s = open(p).read(); open(p, "w").write(s.replace("name: " + sys.argv[2] + "\n", "name: " + sys.argv[3] + "\n", 1))' "$SUITES_DIR/$COPY/suite.yaml" "$SUITE" "$COPY"
  settle
  send_json POST /suites/reload "{\"path\":\"$COPY\"}"
  check "$SUITE: its copy loads as v1, every task valid" 200 \
    'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1 and d["suites"][0]["error"] is None' 'd["suites"][0]["message"]' || continue
  helper tree "$SUITES_DIR/$COPY" >"$WORK/before.json"
  send_json POST "/suites/$COPY/draft" '{}'
  check '  opened as a draft: no change, no problem, every task unchanged' 201 \
    'd["changes"] == [] and d["problems"] == [] and {t["state"] for t in d["tasks"]} == {"unchanged"}' '"{} tasks".format(len(d["tasks"]))'
  request GET "/suites/$COPY/draft/review"
  check '  Review: nothing to write' 200 'd["changes"] == [] and d["writes"] == []'
  save "$COPY"
  check '  saved with no edit: unchanged, still v1' 200 \
    'd["outcome"] == "unchanged" and d["suite"]["versionNumber"] == 1 and d["validCount"] == d["taskCount"]' \
    '"{outcome} · {taskCount} tasks, {validCount} valid".format_map(d)'
  check_file '  no file touched' "$WORK/before.json" 'tree(env["SUITES_DIR"] + "/" + env["COPY"]) == d' '"{} files".format(len(d))'
done

if [ "$DOCKER" = 1 ]; then
  sleep 3
  stop_events
  docker image inspect "$TRIAL_IMAGE" --format '{{json .Config.Env}}' >"$WORK/image-env.json" 2>/dev/null
  TRIAL_ID="$(docker image inspect "$TRIAL_IMAGE" --format '{{.Id}}' 2>/dev/null)"
  export TRIAL_ID
  python3 - "$WORK/verifiers" "$WORK/verifiers.json" <<'PY'
import glob, json, os, sys
out = []
for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.json'))):
    with open(path) as f:
        data = json.load(f)
    if data:
        out.append(data[0])
with open(sys.argv[2], 'w') as f:
    json.dump(out, f)
PY
  # The guard's log is the record of every verifier container; each one this
  # step caught alive is inspected (one that ended first left no inspection).
  dc logs --no-log-prefix --since "$GUARD_FROM" docker-guard >"$WORK/guard.log" 2>/dev/null
  CREATES="$(grep -c 'containers/create?name=hermes-evals-verify-' "$WORK/guard.log")"
  if [ "$CREATES" -ge 2 ] && ! grep 'hermes-evals-verify-' "$WORK/guard.log" | grep -q '"allow":false'; then
    pass 'verifier containers created through docker-guard under its verifier policy (allow: true)' "$CREATES creates"
  else
    fail 'verifier containers created through docker-guard under its verifier policy (allow: true)' "$CREATES creates: $(grep 'hermes-evals-verify-' "$WORK/guard.log" | head -2 | tr '\n' ' ' | cut -c1-300)"
  fi
  if [ "$(jv 'len(d)' "$WORK/verifiers.json" 2>/dev/null)" = 0 ]; then
    skip '  their container specs' 'every verifier container ended before docker inspect reached it'
  else
    check_file '  each on the trial image, network none, read-only root, one read-only /check mount, a 64 MiB /tmp' "$WORK/verifiers.json" \
      'all(c["Image"] == env["TRIAL_ID"] and c["HostConfig"]["NetworkMode"] == "none" and c["HostConfig"]["ReadonlyRootfs"] and [(m["Target"], m.get("ReadOnly")) for m in c["HostConfig"]["Mounts"]] == [("/check", True)] and list(c["HostConfig"]["Tmpfs"]) == ["/tmp"] and "size=64m" in c["HostConfig"]["Tmpfs"]["/tmp"] for c in d) ' \
      '"{} inspected · {} · {}".format(len(d), env["TRIAL_IMAGE"], d[0]["Config"]["Entrypoint"][0])'
    check_file '  cap-drop ALL, no-new-privileges, uid 10000, pids and memory limits, the verifier label' "$WORK/verifiers.json" \
      'all(c["HostConfig"]["CapDrop"] == ["ALL"] and not c["HostConfig"]["CapAdd"] and "no-new-privileges" in c["HostConfig"]["SecurityOpt"] and c["Config"]["User"] == "10000:10000" and c["HostConfig"]["PidsLimit"] and c["HostConfig"]["Memory"] and c["Config"]["Labels"].get("hermes-evals.kind") == "verifier" for c in d)'
    check_file '  no environment but PATH beyond the image'"'"'s own' "$WORK/verifiers.json" \
      'all(sorted({e.split("=")[0] for e in c["Config"]["Env"]} - {e.split("=")[0] for e in json.load(open(env["WORK"] + "/image-env.json"))}) in ([], ["PATH"]) for c in d)'
  fi
  LEFT="$(docker ps -aq --filter name=hermes-evals-verify- | wc -l | tr -d ' ')"
  [ "$LEFT" = 0 ] && pass '  none left behind' || fail '  none left behind' "$LEFT verifier containers"
else
  skip 'verifier containers (docker events, inspect, the guard log)' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section 'Reload all: one job per directory, each folder reported'
# ---------------------------------------------------------------------------

T0="$(date +%s)"
send_json POST /suites/reload '{}'
T1="$(date +%s)"
export SECONDS_TAKEN=$((T1 - T0))
check 'POST /suites/reload: every folder, this run'"'"'s included' 200 \
  'all(any(s["sourcePath"] == "./suites/" + n for s in d["suites"]) for n in [env["FOLDER"], env["ZIPPED"]] + ["invoices-v1", "tools-v1"]) and not [s for s in d["suites"] if s["outcome"] == "error"]' \
  '"{} folders in {} s".format(len(d["suites"]), env["SECONDS_TAKEN"])'
request GET /suites/reload/progress
check '  GET /suites/reload/progress: done, every folder done' 200 \
  'd["active"] is False and d["finishedAt"] and all(x["state"] == "done" for x in d["directories"])' \
  '"{} directories".format(len(d["directories"]))'

# ---------------------------------------------------------------------------
section 'Cleanup'
# ---------------------------------------------------------------------------

for NAME in $MADE; do
  request DELETE "/suites/$NAME/draft" -H 'Content-Type: application/json' --data-binary '{}'
done
cleanup_folders
settle
for NAME in $MADE; do
  send_json POST /suites/reload "{\"path\":\"$NAME\"}"
  NAME="$NAME" check "remove ./suites/$NAME and reload: missing" 200 'd["suites"][0]["outcome"] == "missing"' || true
done
MADE=''
LEFT="$(cd "$SUITES_DIR" && ls -a | grep -c '^\.draft-' || true)"
[ "$LEFT" = 0 ] && pass 'no staging folder left in SUITES_DIR' || fail 'no staging folder left in SUITES_DIR' "$LEFT .draft-* entries"

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILS" "$SKIPS"
[ "$FAILS" -eq 0 ]
