#!/usr/bin/env bash
# Phase 3 smoke test: grades real runs on a running Hermes Evals stack, in
# real trial containers, with real Hermes against the scripted mock model,
# and prints one PASS/FAIL/SKIP line per step. It covers what Phase 3 adds:
#
# - a temporary suite whose three tasks use all eight check types, each
#   passing its self-check: `ledger` (numeric_tolerance, json_match with
#   pass_at 0.9, exact_match, text_match with phrases and a pattern,
#   file_check, trajectory_match on read_file, llm_judge with a rubric,
#   verifier_script), `noanswer` (a reply without the JSON block) and `slow`;
# - two configurations, smoke-a (with a skill) and smoke-b, launched on every
#   task, and the two slow runs cancelled at once, so the experiment holds an
#   unscored run;
# - the scores: smoke-a passes every ledger check, smoke-b fails every one
#   (json_match 4 of 5 keys, text_match 1 of 3, trajectory_match no
#   read_file, the judge's low score), and on `noanswer` the text_match answer
#   is `ungradable` and the verifier and the judge `error`;
# - the evidence behind them (read through `docker compose`): the judge's
#   provider, model, calls and egress-metered tokens, priced at 0; the
#   trajectory's matched seqs; each text_match item; json_match key by key;
#   the judge's requests as the mock received them through egress; no judge
#   registration left; no credential in a score, event or launch record;
# - re-score: one run (generation 2 supersedes 1), a double request that
#   collapses into one evaluation, a bulk re-score with a refusal (the
#   cancelled run), and the 409 while the judge's provider is not ready (the
#   api restarted for that step with the judge on a provider without a key,
#   then restored).
#
#   scripts/phase3-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase3-smoke.sh  # through nginx
#
# The stack needs the mock model (on every start since Phase 8) with the scripts in
# scripts/phase3-mock-scripts.json, and the LLM judge pointed at it. Compose
# mounts the file or directory MOCK_SCRIPTS_FILE names into the mock, and
# reads these from the shell before .env, so no file changes:
#
#   MOCK_SCRIPTS_FILE=./scripts \
#   JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
#     docker compose up -d
#
# (every scripts/*mock-scripts.json, in name order, so the other smoke tests
# pass on the same stack). The mock plays the first script whose `match`
# occurs in a request's messages, so the order within this file matters.
# The judge's three come first, because the
# judge's request holds the task prompt too: one matches a sentence only
# smoke-a's final reply holds (an agent's own requests never hold its final
# reply, so only the judge grading smoke-a sees it) and answers 0.92; one
# matches the noanswer rubric and answers with no JSON; one matches the
# ledger rubric and answers 0.15. Then the noanswer and slow tasks (both
# configurations alike), smoke-a's ledger run (its skill's phrase, in its
# system prompt: Hermes preloads skills whole) and smoke-b's (the task
# prompt). mock/scripted is priced at 0 in config/prices.yaml: no real
# provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl and python3. Exits 0 only when no step
# failed. It writes to the stack it tests, so point it at a development stack
# only. Every name it creates starts with smoke-<UTC timestamp> (the suite
# directory zz-smoke-score-<timestamp>), so it can run again and again. The
# suite directory is removed at the end and reloaded, which leaves its
# suite_sources row `missing`; the experiments, configurations and skill stay
# (there are no delete endpoints).
#
# Settings (environment):
#   BASE_URL       API base URL (default http://localhost:3000/api)
#   SUITES_DIR     host directory the worker reads suites from (default <repo>/suites)
#   SMOKE_DOCKER   auto (default) | 0: also check, through `docker compose`, the judge
#                  settings and the keys' absence, the mock's scripts, the raw score
#                  evidence, the judge's requests in the mock's log, egress's
#                  registrations and the raw events and launch records
#   SMOKE_RESTART  auto (default) | 0: for the judge-not-ready 409, recreate the api
#                  with JUDGE_PROVIDER=openrouter (no key), then again with the
#                  judge settings it had (needs the docker checks)
#   SMOKE_CANARY   optional: a value that must never appear in a score, an event, a
#                  launch record or an API answer (e.g. a fake CUSTOM_API_KEY egress
#                  holds), and must reach the mock in the judge's requests
#   RUN_TIMEOUT    seconds an experiment or a re-score may take (default 300)
#   CURL_TIMEOUT   seconds per request (default 120)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
SMOKE_RESTART="${SMOKE_RESTART:-auto}"
SMOKE_CANARY="${SMOKE_CANARY:-}"
RUN_TIMEOUT="${RUN_TIMEOUT:-300}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
SUITE_NAME="zz-smoke-score-$STAMP"
SUITE_DIR="$SUITES_DIR/$SUITE_NAME"
A_NAME="$PREFIX-a"
B_NAME="$PREFIX-b"
SKILL_NAME="$PREFIX-score-method"
# Matched by scripts/phase3-mock-scripts.json in smoke-a's system prompt.
SKILL_PHRASE='smoke-score-method: read the ledger with read_file and reconcile it'
export PREFIX SUITE_NAME A_NAME B_NAME SKILL_NAME SMOKE_CANARY

for tool in curl python3; do
  command -v "$tool" >/dev/null || { echo "phase3-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase3-smoke.XXXXXX")"
BODY="$WORK/body"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
API_JUDGE_CHANGED=0

# ---------------------------------------------------------------------------
# Helpers (as in phase2-smoke.sh)
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
      -H 'X-Requested-With: phase3-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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
# response) as `d`, with `env`, `json`, `raw` and `sc` (sc(d, key): the score
# row of that key in a run detail). A string prints as it is, anything else
# as JSON. str.format, not f-strings (Python before 3.12).
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
def sc(detail, key):
    return next(s for s in detail['scores'] if s['key'] == key)
try:
    value = eval(expr, {'d': d, 'env': os.environ, 'json': json, 'raw': raw, 'sc': sc})
except Exception as exc:
    print('{}: {}'.format(type(exc).__name__, exc), file=sys.stderr)
    sys.exit(1)
print(value if isinstance(value, str) else json.dumps(value))
PY
}

line() { printf '%-5s %-64s %s\n' "$1" "$2" "$3"; }
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

# Docker checks run when the stack is this repository's Compose project here.
DOCKER=0
if [ "$SMOKE_DOCKER" != 0 ] && command -v docker >/dev/null &&
  (cd "$REPO_DIR" && docker compose ps --status running --services 2>/dev/null | grep -qx worker); then
  DOCKER=1
fi
dc() { (cd "$REPO_DIR" && docker compose "$@"); }
psql_ro() { dc exec -T postgres psql -U hermes -d hermes_evals -At -c "$1" 2>/dev/null; }
# egress_health FIELD: one field of egress's admin /health (attempts, judges).
egress_health() {
  dc exec -T egress node -e "require('http').get({socketPath:'/run/egress/admin.sock',path:'/health'},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.parse(b)['$1']))})" 2>/dev/null
}
# The mock's log of every request it received (GET /__requests), into FILE.
mock_requests() {
  dc exec -T mock-model node -e "fetch('http://localhost:8090/__requests').then(r=>r.text()).then(t=>process.stdout.write(t))" >"$1" 2>/dev/null
}
# api_judge PROVIDER MODEL BASE_URL: recreates the api with these judge
# settings (Compose reads them from the shell) and waits until it is healthy.
api_judge() {
  JUDGE_PROVIDER="$1" JUDGE_MODEL="$2" JUDGE_BASE_URL="$3" dc up -d --no-deps api >"$WORK/compose.log" 2>&1 || return 1
  sleep 2
  wait_for /health 'd["status"] == "ok"' 120
}

# Puts the api's judge settings back if a step changed them, removes the
# temporary suite directory (and reloads it, so it is `missing`), then the
# work directory.
cleanup() {
  if [ "$API_JUDGE_CHANGED" = 1 ]; then
    api_judge "$ORIG_JUDGE_PROVIDER" "$ORIG_JUDGE_MODEL" "$ORIG_JUDGE_BASE_URL" ||
      echo "phase3-smoke: could not restore the api's judge settings" >&2
  fi
  if [ -d "$SUITE_DIR" ]; then
    rm -rf "$SUITE_DIR"
    send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

printf 'Phase 3 smoke · %s · stamp %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

# ---------------------------------------------------------------------------
section 'Stack'
# ---------------------------------------------------------------------------

request GET /health
check 'GET /health' 200 \
  'd["status"] == "ok" and all(v == "ok" for v in d["checks"].values())' \
  '"status " + d["status"] + " · " + ", ".join(k + " " + v for k, v in d["checks"].items())'

request GET /system/workers
check 'GET /system/workers: a worker online, sandbox proven' 200 \
  'any(w["status"] == "online" and w["sandboxProven"] for w in d)' \
  '"; ".join("{} concurrency {} slots {}/{}".format(w["id"], w["concurrency"], w["slotsInUse"], w["slotsTotal"]) for w in d if w["status"] == "online")'

request GET /providers
check 'GET /providers: custom is ready (the judge and the trials use it)' 200 \
  'next(p for p in d if p["id"] == "custom")["status"] == "configured"' \
  '", ".join("{} {}".format(p["id"], p["status"]) for p in d)'

ORIG_JUDGE_PROVIDER=''
ORIG_JUDGE_MODEL=''
ORIG_JUDGE_BASE_URL=''
if [ "$DOCKER" = 1 ]; then
  for svc in api worker; do
    SEEN="$(dc exec -T "$svc" sh -c 'echo "$JUDGE_PROVIDER $JUDGE_MODEL $JUDGE_BASE_URL"' 2>/dev/null)"
    if [ "$SEEN" = 'custom mock/scripted http://mock-model:8090/v1' ]; then
      pass "$svc: the judge is the mock (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL)" "$SEEN"
    else
      fail "$svc: the judge is the mock (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL)" "'$SEEN'; start the stack as the header says"
    fi
    KEYS="$(dc exec -T "$svc" sh -c 'for n in NOUS_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY CUSTOM_API_KEY; do [ -n "$(printenv $n)" ] && echo $n; done' 2>/dev/null | tr '\n' ' ')"
    if [ -z "$KEYS" ]; then
      pass "$svc: holds no provider key" 'NOUS_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY CUSTOM_API_KEY empty'
    else
      fail "$svc: holds no provider key" "set: $KEYS"
    fi
  done
  ORIG_JUDGE_PROVIDER="$(dc exec -T api printenv JUDGE_PROVIDER 2>/dev/null)"
  ORIG_JUDGE_MODEL="$(dc exec -T api printenv JUDGE_MODEL 2>/dev/null)"
  ORIG_JUDGE_BASE_URL="$(dc exec -T api printenv JUDGE_BASE_URL 2>/dev/null)"
  export ORIG_JUDGE_PROVIDER ORIG_JUDGE_MODEL ORIG_JUDGE_BASE_URL
  NAMES="$(psql_ro "select array_to_string(env_names, ' ') from workers where stopped_at is null order by last_heartbeat_at desc limit 1")"
  if echo " $NAMES " | grep -q ' JUDGE_PROVIDER ' && ! echo " $NAMES " | grep -q -E ' (NOUS|OPENROUTER|OPENAI|ANTHROPIC|CUSTOM)_API_KEY '; then
    pass 'workers row: JUDGE_* recorded by name, no key name' "$(echo "$NAMES" | tr ' ' '\n' | grep -c .) names, JUDGE_PROVIDER JUDGE_MODEL JUDGE_BASE_URL among them"
  else
    fail 'workers row: JUDGE_* recorded by name, no key name' "$NAMES"
  fi
  CHECKDEF="$(psql_ro "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'scores'::regclass and pg_get_constraintdef(oid) like '%text_match%'")"
  MIGRATIONS="$(psql_ro 'select count(*) from drizzle.__drizzle_migrations')"
  if [ -n "$CHECKDEF" ] && [ "${MIGRATIONS:-0}" -ge 7 ]; then
    pass 'migration 0006: scores accept text_match' "$MIGRATIONS migrations applied"
  else
    fail 'migration 0006: scores accept text_match' "migrations ${MIGRATIONS:-?} · CHECK '$CHECKDEF'"
  fi
  if dc exec -T mock-model node dist/mock-model.js --print-scripts 2>/dev/null | grep 'Smoke rubric LEDGER-JUDGE' >/dev/null; then
    pass 'the mock model has scripts/phase3-mock-scripts.json' 'its scripts match "Smoke rubric LEDGER-JUDGE", ...'
  else
    fail 'the mock model has scripts/phase3-mock-scripts.json' 'start it as the header says (MOCK_SCRIPTS_FILE)'
  fi
else
  skip 'judge settings, keys, workers row, migration, mock scripts' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
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
fenced = '\n\nEnd your reply with a fenced JSON block:\n\n```json\n{}\n```\n'
ledger_csv = ('invoice,vendor,amount,currency,status,due\nL-1,Acme,400.00,EUR,open,2026-11-30\n'
              'L-2,Acme,250.50,EUR,open,2026-11-30\nL-3,Acme,392.00,EUR,open,2026-11-30\n'
              'L-4,Borealis,75.25,EUR,paid,2026-10-15\n')
put('suite.yaml', "name: {}\nversion_label: '0.1'\ndescription: Temporary Phase 3 smoke suite, every check type, graded against the scripted mock model.\n"
    'tasks: [ledger, noanswer, slow]\n'.format(name))

put('ledger/task.yaml', 'summary: Totals, the Acme record, the ledger code, the late fee rule and summary.csv\n'
    'limits:\n  max_turns: 10\n  run_budget_seconds: 120\n  toolsets_needed: [file, terminal]\n'
    'answer:\n  format: fenced_json\n  path: total\n'
    'verification:\n'
    '  - key: total\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n'
    '  - key: record\n    type: json_match\n    params: { path: record, pass_at: 0.9 }\n'
    '  - key: code\n    type: exact_match\n    params: { path: code }\n'
    '  - key: fee_rule\n    type: text_match\n'
    "    params: { path: note, contains: [late fee, 30 days], pattern: '\\d+(\\.\\d+)?% per month' }\n"
    '  - key: summary_csv\n    type: file_check\n'
    '    params: { path: summary.csv, format: csv, columns: [vendor, total], row_count: 2, contains: ["Acme,1042.50"] }\n'
    '  - key: reads_ledger\n    type: trajectory_match\n'
    '    params: { tool: read_file, args: { path: /workspace/ledger.csv }, min_calls: 1, max_calls: 2 }\n'
    '  - key: quality\n    type: llm_judge\n    params: { rubric: rubric.md }\n'
    '  - key: verifier\n    type: verifier_script\n    params: { script: check.py }\n'
    'self_check:\n  expected_workspace: expected\n')
put('ledger/prompt.md', 'Smoke score task LEDGER. Read `ledger.csv` and `terms.txt` in your workspace.\n\n'
    '1. Total the `amount` of the open Acme invoices.\n'
    '2. Describe the Acme record: vendor, number of invoices, currency, status and due date.\n'
    '3. Give the ledger code from `terms.txt`.\n'
    '4. State the late fee rule in one sentence.\n'
    '5. Write `summary.csv` with the columns vendor,total: one row per vendor.' +
    fenced.format('{ "total": 0.0, "record": { "vendor": "", "invoices": 0, "currency": "", "status": "", "due": "" }, "code": "", "note": "" }'))
put('ledger/fixtures/ledger.csv', ledger_csv)
put('ledger/fixtures/terms.txt', 'Ledger code: LEDGER-7Q.\nInvoices unpaid 30 days after the due date are charged a late fee of 1.5% per month.\n')
put('ledger/expected/summary.csv', 'vendor,total\nAcme,1042.50\nBorealis,75.25\n')
put('ledger/reference.json', json.dumps({
    'total': 1042.50,
    'record': {'vendor': 'Acme', 'invoices': 3, 'currency': 'EUR', 'status': 'open', 'due': '2026-11-30'},
    'code': 'LEDGER-7Q',
    'note': 'A late fee of 1.5% per month applies after 30 days.'}, indent=2) + '\n')
put('ledger/rubric.md', 'Smoke rubric LEDGER-JUDGE ({}). Score 1 when the reply gives the total of the open Acme '
    'invoices (1042.50) and the late fee rule (1.5% per month after 30 days); 0.5 when it gives one of them; '
    '0 otherwise.\n'.format(name))
put('ledger/verify/check.py', '''"""summary.csv's Acme total must equal the answer's total."""
import argparse, csv, json, os

parser = argparse.ArgumentParser()
parser.add_argument('--answer', required=True)
parser.add_argument('--workspace', required=True)
parser.add_argument('--home', required=True)
args = parser.parse_args()
with open(args.answer, encoding='utf-8') as f:
    answer = json.load(f)
path = os.path.join(args.workspace, 'summary.csv')
if not os.path.exists(path):
    print(json.dumps({'score': 0, 'comment': 'summary.csv is missing'}))
else:
    with open(path, encoding='utf-8', newline='') as f:
        acme = next((row for row in csv.DictReader(f) if row.get('vendor') == 'Acme'), None)
    want = answer.get('total') if isinstance(answer, dict) else None
    try:
        ok = abs(float(acme['total']) - float(want)) < 0.005
    except (KeyError, TypeError, ValueError):
        ok = False
    shown = acme.get('total') if acme else None
    print(json.dumps({'score': 1 if ok else 0,
                      'comment': 'summary.csv Acme total {} against the answer {}'.format(shown, want)}))
''')

put('noanswer/task.yaml', 'summary: Whether ledger.csv starts with a header row\n'
    'limits:\n  max_turns: 4\n  run_budget_seconds: 120\n  toolsets_needed: [terminal]\n'
    'answer:\n  format: fenced_json\n  path: reply\n'
    'verification:\n'
    '  - key: answer\n    type: text_match\n    primary: true\n    params: { contains: [header row] }\n'
    '  - key: verifier\n    type: verifier_script\n    params: { script: needs_answer.py }\n'
    '  - key: quality\n    type: llm_judge\n    params: { rubric: rubric.md }\n')
put('noanswer/prompt.md', 'Smoke score task NOANSWER. Does `ledger.csv` start with a header row?' + fenced.format('{ "reply": "..." }'))
put('noanswer/fixtures/ledger.csv', ledger_csv)
put('noanswer/reference.json', '{ "reply": "Yes, ledger.csv starts with a header row." }\n')
put('noanswer/rubric.md', 'Smoke rubric NOANSWER-JUDGE ({}). Score 1 when the reply says that ledger.csv starts '
    'with a header row; 0 otherwise.\n'.format(name))
put('noanswer/verify/needs_answer.py', '''"""Breaks (exit 3) when there is no answer: the key is then `error`, not a zero."""
import argparse, json, sys

parser = argparse.ArgumentParser()
parser.add_argument('--answer', required=True)
parser.add_argument('--workspace', required=True)
parser.add_argument('--home', required=True)
args = parser.parse_args()
with open(args.answer, encoding='utf-8') as f:
    answer = json.load(f)
if answer is None:
    print('there is no answer to check', file=sys.stderr)
    sys.exit(3)
found = 'header' in json.dumps(answer)
print(json.dumps({'score': 1 if found else 0, 'comment': 'the reply names the header' if found else 'no header in the reply'}))
''')

put('slow/task.yaml', 'summary: The number of rows in ledger.csv, slowly\n'
    'limits:\n  max_turns: 4\n  run_budget_seconds: 200\n  toolsets_needed: [terminal]\n'
    'answer:\n  format: fenced_json\n  path: rows\n'
    'verification:\n  - key: rows\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0 }\n')
put('slow/prompt.md', 'Smoke score task SLOW. Count the data rows of `ledger.csv` (not the header).' + fenced.format('{ "rows": 0 }'))
put('slow/fixtures/ledger.csv', ledger_csv)
put('slow/reference.json', '{ "rows": 4 }\n')
PY

send_json POST /suites/reload "{\"path\":\"./suites/$SUITE_NAME\"}"
check 'reload the new directory -> created v1' 200 \
  'd["suites"][0]["outcome"] == "created" and d["suites"][0]["versionNumber"] == 1' \
  '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
SUITE_ID="$(jv 'd["suites"][0]["suiteId"]' 2>/dev/null)"
export SUITE_ID

if need 'suite detail: 3 valid tasks' "$SUITE_ID"; then
  request GET "/suites/$SUITE_ID"
  check 'suite detail: 3 valid tasks' 200 \
    'd["validCount"] == d["taskCount"] == 3 and sorted(t["key"] for t in d["tasks"]) == ["ledger", "noanswer", "slow"]' \
    '", ".join("{} v{} {}".format(t["key"], t["version"], "valid" if t["valid"] else "INVALID") for t in d["tasks"])'
  TYPES=''
  for TASK in ledger noanswer slow; do
    request GET "/suites/$SUITE_ID/tasks/$TASK"
    check "  $TASK: self-check passed" 200 \
      'd["selfCheck"]["status"] == "passed" and all(r["status"] in ("passed", "skipped") or r.get("expect") == "fail" for r in d["selfCheck"]["results"])' \
      '", ".join("{}:{}{}".format(r["key"], r["status"], " (negative control)" if r.get("expect") == "fail" else "") for r in d["selfCheck"]["results"])'
    TYPES="$TYPES $(jv '" ".join(v["type"] for v in d["verification"])' 2>/dev/null)"
  done
  export TYPES
  if python3 -c 'import os, sys; t = set(os.environ["TYPES"].split()); sys.exit(0 if t == {"numeric_tolerance", "json_match", "exact_match", "text_match", "file_check", "trajectory_match", "llm_judge", "verifier_script"} else 1)'; then
    pass 'the tasks use all 8 check types' "$(echo "$TYPES" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
  else
    fail 'the tasks use all 8 check types' "$TYPES"
  fi
fi

# ---------------------------------------------------------------------------
section 'Skill and configurations'
# ---------------------------------------------------------------------------

SKILL_ZIP="$WORK/$SKILL_NAME.zip"
python3 - "$SKILL_ZIP" "$SKILL_NAME" "$SKILL_PHRASE" <<'PY'
import sys, zipfile
path, name, phrase = sys.argv[1:4]
md = '---\nname: {}\nversion: 1.0.0\ndescription: Smoke-test skill. How to read a ledger before answering.\n---\n\n# Ledger method\n\n{}.\n'.format(name, phrase)
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
  check 'POST /resources/skills (confirm)' 201 'd["name"] == env["SKILL_NAME"]' '"{name}@{version}".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
fi

config_body() {
  printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":["file","terminal"],"memoryEnabled":false,"skillIds":[%s],"documentIds":[],"mcpServerVersionIds":[],"maxTurns":10,"timeBudgetS":120,"duplicatedFromVersionId":null}' "$1" "$2"
}
A_VERSION=''
if need "POST /configurations $A_NAME" "$SKILL_ID"; then
  send_json POST /configurations "$(config_body "$A_NAME" "\"$SKILL_ID\"")"
  check "POST /configurations $A_NAME (custom, mock, the skill)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)'
  A_VERSION="$(jv 'd["versionId"]' 2>/dev/null)"
fi
send_json POST /configurations "$(config_body "$B_NAME" '')"
check "POST /configurations $B_NAME (custom, mock)" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)'
B_VERSION="$(jv 'd["versionId"]' 2>/dev/null)"
export A_VERSION B_VERSION

# launch_body NAME TASKS: the POST /experiments body for both configurations.
launch_body() {
  python3 - "$WORK/options.json" "$1" "$2" <<'PY'
import json, os, sys
options, name, tasks = sys.argv[1:4]
o = json.load(open(options))
h = {c['versionId']: c['configHash'] for c in o['configurations']}
a, b = os.environ['A_VERSION'], os.environ['B_VERSION']
conc = max(1, min(3, o['maxConcurrency']))
print(json.dumps({'name': name, 'description': 'phase3-smoke: ' + name, 'suiteId': os.environ['SUITE_ID'],
                  'taskKeys': tasks.split(','), 'baselineVersionId': a, 'candidateVersionIds': [b],
                  'repetitions': 1, 'concurrency': conc, 'spendCeilingUsd': None,
                  'timeBudgetOverrideS': None, 'expectedConfigHashes': {a: h[a], b: h[b]}}))
PY
}

# ---------------------------------------------------------------------------
section 'Experiment: 3 tasks x 2 configurations, the slow runs cancelled'
# ---------------------------------------------------------------------------

EXP=''
if need 'POST /experiments (launch)' "$SUITE_ID" "$A_VERSION" "$B_VERSION"; then
  request GET /experiments/new-options
  cp "$BODY" "$WORK/options.json"
  send_json POST /experiments "$(launch_body "$PREFIX-score" ledger,noanswer,slow)"
  check 'POST /experiments (launch)' 201 'bool(d["id"])' '"experiment " + d["id"]'
  [ "$STATUS" = 201 ] && EXP="$(jv 'd["id"]' 2>/dev/null)"
fi
export EXP

SLOW_RUNS=''
if need 'cancel the two slow runs' "$EXP"; then
  request GET "/experiments/$EXP/runs"
  SLOW_RUNS="$(jv '" ".join(r["id"] for r in d["rows"] if r["taskKey"] == "slow")' 2>/dev/null)"
  CANCELLED=0
  for RID in $SLOW_RUNS; do
    send_json POST "/runs/$RID/cancel"
    [ "$STATUS" = 200 ] && CANCELLED=$((CANCELLED + 1))
  done
  if [ "$CANCELLED" = 2 ]; then
    pass 'POST /runs/:id/cancel on both slow runs' "$SLOW_RUNS"
  else
    fail 'POST /runs/:id/cancel on both slow runs' "$CANCELLED of 2 accepted: $(snippet)"
  fi
fi
SLOW_RUN="${SLOW_RUNS%% *}"
export SLOW_RUN

if need 'experiment completes: 4 scored, 2 cancelled' "$EXP"; then
  if wait_for "/experiments/$EXP" 'd["status"] in ("completed", "failed")' "$RUN_TIMEOUT"; then
    check 'experiment completes: 4 scored, 2 cancelled' 200 \
      'd["status"] == "completed" and d["counts"]["scored"] == 4 and d["counts"]["cancelled"] == 2' \
      '"{} in {} s · ".format(d["status"], d["elapsedS"]) + ", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)'
  else
    fail 'experiment completes: 4 scored, 2 cancelled' "still $(jv 'd["status"] + " " + json.dumps({k: v for k, v in d["counts"].items() if v})' 2>/dev/null) after ${RUN_TIMEOUT} s"
  fi
fi

# ---------------------------------------------------------------------------
section 'Scores: every check type, right (smoke-a) and wrong (smoke-b)'
# ---------------------------------------------------------------------------

A_LEDGER=''
B_LEDGER=''
A_NOANSWER=''
B_NOANSWER=''
if need 'GET /experiments/:id/runs' "$EXP"; then
  request GET "/experiments/$EXP/runs"
  cp "$BODY" "$WORK/runs.json"
  check 'GET /experiments/:id/runs: primary results, generation 1' 200 \
    'sorted((r["taskKey"], r["configuration"]["name"] == env["A_NAME"], r["status"], (r["primaryScore"] or {}).get("status"), r["generation"]) for r in d["rows"]) == sorted([("ledger", True, "scored", "passed", 1), ("ledger", False, "scored", "failed", 1), ("noanswer", True, "scored", "ungradable", 1), ("noanswer", False, "scored", "ungradable", 1), ("slow", True, "cancelled", None, None), ("slow", False, "cancelled", None, None)]) and not any(r["rescorePending"] for r in d["rows"])' \
    '", ".join("{}/{} {} {}".format(r["taskKey"], r["configuration"]["name"][-1], r["status"], (r["primaryScore"] or {}).get("status")) for r in d["rows"])'
  run_of() { jv "next(r['id'] for r in d['rows'] if r['taskKey'] == '$1' and r['configuration']['name'] == env['$2'])" "$WORK/runs.json" 2>/dev/null; }
  A_LEDGER="$(run_of ledger A_NAME)"
  B_LEDGER="$(run_of ledger B_NAME)"
  A_NOANSWER="$(run_of noanswer A_NAME)"
  B_NOANSWER="$(run_of noanswer B_NAME)"
fi
export A_LEDGER B_LEDGER A_NOANSWER B_NOANSWER

if need 'GET /runs/:id ledger smoke-a' "$A_LEDGER"; then
  request GET "/runs/$A_LEDGER"
  cp "$BODY" "$WORK/a-ledger.json"
  check 'ledger smoke-a: all 8 keys passed' 200 \
    'sorted((s["key"], s["type"], s["status"]) for s in d["scores"]) == sorted([("total", "numeric_tolerance", "passed"), ("record", "json_match", "passed"), ("code", "exact_match", "passed"), ("fee_rule", "text_match", "passed"), ("summary_csv", "file_check", "passed"), ("reads_ledger", "trajectory_match", "passed"), ("quality", "llm_judge", "passed"), ("verifier", "verifier_script", "passed")]) and d["evaluation"]["generation"] == 1 and d["evaluation"]["pending"] is None' \
    '"; ".join("{} {} {}".format(s["key"], s["status"], s["score"]) for s in d["scores"])'
  check '  the judge: 0.92 and its comment; needs the custom judge' 200 \
    'sc(d, "quality")["score"] == 0.92 and "States the total of 1042.50" in sc(d, "quality")["comment"] and d["needs"]["judgeKeys"] == ["quality"] and d["needs"]["judgeProvider"] == "custom"' \
    'sc(d, "quality")["comment"][:90]'
  check '  trajectory_match points at the read_file event' 200 \
    'len(sc(d, "reads_ledger")["evidence"]["eventSeqs"]) == 1 and any(e["kind"] == "tool" and e["title"] == "read_file" and e["seq"] == sc(d, "reads_ledger")["evidence"]["eventSeqs"][0] for e in d["timeline"]["events"])' \
    '"seq {} · {}".format(sc(d, "reads_ledger")["evidence"]["eventSeqs"], sc(d, "reads_ledger")["comment"][:70])'
  check '  timeline: every network row has its kind; model calls to mock/scripted' 200 \
    'all(e["network"]["kind"] in ("model", "mcp", "connect", "http") for e in d["timeline"]["events"] if e["kind"] == "network") and sum(1 for e in d["timeline"]["events"] if e["kind"] == "network" and e["network"]["kind"] == "model" and e["network"]["model"] == "mock/scripted") >= 2' \
    '", ".join(sorted({"{}:{}".format(e["network"]["kind"], e["network"]["status"]) for e in d["timeline"]["events"] if e["kind"] == "network"}))'
fi

if need 'GET /runs/:id ledger smoke-b' "$B_LEDGER"; then
  request GET "/runs/$B_LEDGER"
  cp "$BODY" "$WORK/b-ledger.json"
  check 'ledger smoke-b: all 8 keys failed' 200 \
    'all(s["status"] == "failed" for s in d["scores"]) and len(d["scores"]) == 8' \
    '"; ".join("{} {}".format(s["key"], s["score"]) for s in d["scores"])'
  check '  json_match partial: 0.8 below pass_at 0.9' 200 \
    'sc(d, "record")["score"] == 0.8' 'sc(d, "record")["comment"][:100]'
  check '  text_match: 1 of 3 found' 200 \
    'abs(sc(d, "fee_rule")["score"] - 1 / 3) < 0.001' 'sc(d, "fee_rule")["comment"][:100]'
  check '  trajectory_match: no read_file call; the judge 0.15' 200 \
    'sc(d, "reads_ledger")["score"] == 0 and sc(d, "reads_ledger")["evidence"]["eventSeqs"] == [] and not any(e["kind"] == "tool" and e["title"] == "read_file" for e in d["timeline"]["events"]) and sc(d, "quality")["score"] == 0.15' \
    'sc(d, "reads_ledger")["comment"][:60] + " · " + sc(d, "quality")["comment"][:50]'
fi

for RID in "$A_NOANSWER" "$B_NOANSWER"; do
  if need 'noanswer: ungradable answer, error verifier and judge' "$RID"; then
    request GET "/runs/$RID"
    check "noanswer $([ "$RID" = "$A_NOANSWER" ] && echo smoke-a || echo smoke-b): answer ungradable, verifier and judge error" 200 \
      'sc(d, "answer")["status"] == "ungradable" and sc(d, "verifier")["status"] == "error" and sc(d, "quality")["status"] == "error" and sc(d, "answer")["score"] is None and sc(d, "quality")["error"] is not None' \
      '"; ".join("{} {}: {}".format(s["key"], s["status"], ((s["error"] or {}).get("message") or s["comment"])[:48]) for s in d["scores"])'
  fi
done

# ---------------------------------------------------------------------------
section 'Evidence (raw score rows, the mock, egress)'
# ---------------------------------------------------------------------------

if [ "$DOCKER" = 1 ] && [ -n "$EXP" ]; then
  psql_ro "select coalesce(json_agg(json_build_object('run', e.run_id, 'gen', e.generation, 'key', s.key, 'type', s.type, 'status', s.status, 'score', s.score, 'version', s.scorer_version, 'comment', s.comment, 'evidence', s.evidence)), '[]') from scores s join evaluations e on e.id = s.evaluation_id join runs r on r.id = e.run_id where r.experiment_id = '$EXP' and e.superseded_at is null" >"$WORK/scores.json"
  # sx RUNVAR KEY: the expression for one score row of the current evaluations.
  sx() { printf 'next(x for x in d if x["run"] == env["%s"] and x["key"] == "%s")' "$1" "$2"; }
  check_file 'evidence.judge: custom, mock/scripted, 1 call, egress-metered tokens, $0' "$WORK/scores.json" \
    "all(j['provider'] == 'custom' and j['model'] == 'mock/scripted' and j.get('base_url') == 'http://mock-model:8090/v1' and j['calls'] == 1 and j['tokens']['total'] > 0 and j['tokens']['total'] == j['tokens']['input'] + j['tokens']['output'] and j['cost_usd'] == 0 for j in [$(sx A_LEDGER quality)['evidence']['judge'], $(sx B_LEDGER quality)['evidence']['judge']])" \
    "'smoke-a {} tokens, smoke-b {} tokens'.format($(sx A_LEDGER quality)['evidence']['judge']['tokens']['total'], $(sx B_LEDGER quality)['evidence']['judge']['tokens']['total'])"
  check_file '  the noanswer judge: error with the reason and its tokens' "$WORK/scores.json" \
    "$(sx A_NOANSWER quality)['status'] == 'error' and $(sx A_NOANSWER quality)['evidence']['judge']['calls'] == 1 and 'JSON' in $(sx A_NOANSWER quality)['evidence']['error']['message']" \
    "$(sx A_NOANSWER quality)['evidence']['error']['message'][:100]"
  check_file 'evidence.trajectory: read_file 2 calls, 1 matched (ledger.csv)' "$WORK/scores.json" \
    "$(sx A_LEDGER reads_ledger)['evidence']['trajectory']['tool'] == 'read_file' and $(sx A_LEDGER reads_ledger)['evidence']['trajectory']['calls'] == 2 and len($(sx A_LEDGER reads_ledger)['evidence']['trajectory']['matched_seqs']) == 1 and $(sx A_LEDGER reads_ledger)['evidence']['event_seqs'] == $(sx A_LEDGER reads_ledger)['evidence']['trajectory']['matched_seqs'] and $(sx B_LEDGER reads_ledger)['evidence']['trajectory']['calls'] == 0 and $(sx B_LEDGER reads_ledger)['evidence']['trajectory']['matched_seqs'] == []" \
    "'smoke-a {} · smoke-b {}'.format(json.dumps($(sx A_LEDGER reads_ledger)['evidence']['trajectory']), json.dumps($(sx B_LEDGER reads_ledger)['evidence']['trajectory']))"
  check_file 'evidence.text: each phrase and the pattern, found or not' "$WORK/scores.json" \
    "[(i['kind'], i['found']) for i in $(sx A_LEDGER fee_rule)['evidence']['text']['items']] == [('phrase', True), ('phrase', True), ('pattern', True)] and [(i['label'], i['found']) for i in $(sx B_LEDGER fee_rule)['evidence']['text']['items']] == [('late fee', True), ('30 days', False), ('\\\\d+(\\\\.\\\\d+)?% per month', False)]" \
    "' '.join('{}={}'.format(i['label'], i['found']) for i in $(sx B_LEDGER fee_rule)['evidence']['text']['items'])"
  # json_match's evidence key by key (Phase 7): the compared path, the counts,
  # the mismatch paths, and each key with both sides and whether it matched.
  # Entries are compared sorted by path, since the reference reaches the
  # scorer with its keys in Postgres's order. test/phase3-smoke.spec.ts
  # derives both from the real scorer, this script's reference and the mock's
  # two replies.
  export JSON_MATCH_A='{"path":"record","unit":"keys","matched":5,"total":5,"mismatches":[],"entries":[{"path":"currency","expected":"EUR","observed":"EUR","match":true},{"path":"due","expected":"2026-11-30","observed":"2026-11-30","match":true},{"path":"invoices","expected":3,"observed":3,"match":true},{"path":"status","expected":"open","observed":"open","match":true},{"path":"vendor","expected":"Acme","observed":"Acme","match":true}]}'
  export JSON_MATCH_B='{"path":"record","unit":"keys","matched":4,"total":5,"mismatches":["status"],"entries":[{"path":"currency","expected":"EUR","observed":"EUR","match":true},{"path":"due","expected":"2026-11-30","observed":"2026-11-30","match":true},{"path":"invoices","expected":3,"observed":3,"match":true},{"path":"status","expected":"open","observed":"paid","match":false},{"path":"vendor","expected":"Acme","observed":"Acme","match":true}]}'
  # jm EXPR: the evidence of EXPR's score row, its entries sorted by path.
  jm() { printf "(lambda j: dict(j, entries=sorted(j['entries'], key=lambda e: e['path'])))(%s['evidence']['json_match'])" "$1"; }
  check_file 'evidence.json_match: key by key, 5 of 5, then 4 of 5 (status)' "$WORK/scores.json" \
    "$(jm "$(sx A_LEDGER record)") == json.loads(env['JSON_MATCH_A']) and $(jm "$(sx B_LEDGER record)") == json.loads(env['JSON_MATCH_B'])" \
    "'{matched} of {total} at {path}, mismatches {mismatches}'.format_map($(sx B_LEDGER record)['evidence']['json_match'])"
  # verifier_script is 2 since Phase 6, which passes --home <dir> as well.
  check_file 'scorer versions on the rows: llm_judge 2, trajectory_match 2, verifier_script 2, text_match 1' "$WORK/scores.json" \
    "{x['type']: x['version'] for x in d} == {'numeric_tolerance': 1, 'json_match': 1, 'exact_match': 1, 'text_match': 1, 'file_check': 1, 'trajectory_match': 2, 'llm_judge': 2, 'verifier_script': 2}" \
    "' '.join(sorted('{}@{}'.format(t, v) for t, v in {x['type']: x['version'] for x in d}.items()))"

  # The judge's requests as the mock received them: through egress (the only
  # service on the mock's network besides nous-proxy), with the judge's rules.
  mock_requests "$WORK/mock.json"
  python3 - "$WORK/mock.json" "$SUITE_NAME" >"$WORK/judged.json" <<'PY'
import json, sys
log, suite = json.load(open(sys.argv[1])), sys.argv[2]
judged = [r for r in log if any(suite in (m.get('content') or '') for m in r['body'].get('messages', []) if isinstance(m, dict))]
print(json.dumps([{'path': r['path'], 'script': r['script'], 'roles': [m['role'] for m in r['body']['messages']],
                   'temperature': r['body'].get('temperature'), 'max_tokens': r['body'].get('max_tokens'),
                   'stream': r['body'].get('stream'), 'tools': 'tools' in r['body'],
                   'auth': r['headers'].get('authorization'),
                   'delimited': 'AGENT_RESPONSE_BEGIN' in r['body']['messages'][-1]['content']} for r in judged]))
PY
  check_file "the mock's log: 4 judge requests, through egress, temperature 0, 4096 tokens" "$WORK/judged.json" \
    'len(d) == 4 and all(r["path"] == "/v1/chat/completions" and r["roles"] == ["system", "user"] and r["temperature"] == 0 and r["max_tokens"] == 4096 and not r["stream"] and not r["tools"] and r["delimited"] for r in d) and sorted(r["script"] for r in d) == sorted(["Every ledger row was reconciled", "Smoke rubric LEDGER-JUDGE", "Smoke rubric NOANSWER-JUDGE", "Smoke rubric NOANSWER-JUDGE"])' \
    '", ".join(sorted(r["script"] for r in d))'
  if [ -n "$SMOKE_CANARY" ]; then
    check_file '  egress sent its CUSTOM_API_KEY (the canary) upstream' "$WORK/judged.json" \
      'all(r["auth"] == "Bearer " + env["SMOKE_CANARY"] for r in d)' '"Authorization: Bearer <canary> on all {}".format(len(d))'
  fi
  JUDGES_LEFT="$(egress_health judges)"
  ATTEMPTS_LEFT="$(egress_health attempts)"
  if [ "$JUDGES_LEFT" = 0 ] && [ "$ATTEMPTS_LEFT" = 0 ]; then
    pass 'no judge registration and no attempt left in egress' 'judges 0 · attempts 0'
  else
    fail 'no judge registration and no attempt left in egress' "judges ${JUDGES_LEFT:-?} · attempts ${ATTEMPTS_LEFT:-?}"
  fi

  # No credential anywhere it could leak to: the scores, the events, the launch records.
  psql_ro "select coalesce(json_agg(a.launch_record), '[]') from attempts a join runs r on r.id = a.run_id where r.experiment_id = '$EXP'" >"$WORK/records.json"
  psql_ro "select coalesce(json_agg(e.payload), '[]') from run_events e join attempts a on a.id = e.attempt_id join runs r on r.id = a.run_id where r.experiment_id = '$EXP'" >"$WORK/events.json"
  python3 - "$WORK" <<'PY' >"$WORK/leaks.json"
import json, os, re, sys
work = sys.argv[1]
canary = os.environ.get('SMOKE_CANARY') or None
pattern = re.compile(r'Bearer [A-Za-z0-9._~+/-]{8,}|sk-[A-Za-z0-9]{16,}|@egress:')
out = {}
for name in ('scores', 'events', 'records', 'a-ledger', 'b-ledger'):
    text = open(os.path.join(work, name + '.json'), encoding='utf-8').read()
    out[name] = {'bytes': len(text), 'pattern': bool(pattern.search(text)), 'canary': bool(canary and canary in text)}
print(json.dumps(out))
PY
  check_file 'no credential in a score, an event, a launch record or a run answer' "$WORK/leaks.json" \
    'all(not v["pattern"] and not v["canary"] for v in d.values()) and d["events"]["bytes"] > 1000 and d["records"]["bytes"] > 1000' \
    '", ".join("{} {} bytes".format(k, v["bytes"]) for k, v in d.items()) + (" · canary checked" if env.get("SMOKE_CANARY") else "")'
  check_file '  launch records: the token as a placeholder' "$WORK/records.json" \
    'len(d) >= 4 and all(r["argv"][r["argv"].index("--api-key") + 1] == "<attempt-token>" for r in d)' \
    '"{} launch records".format(len(d))'
else
  skip 'raw score evidence, the mock log, egress, leaks' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section 'Re-score'
# ---------------------------------------------------------------------------

# One run: generation 2, the run stays scored, the old result current until it publishes.
if need 'POST /runs/:id/rescore (ledger smoke-a)' "$A_LEDGER"; then
  send_json POST "/runs/$A_LEDGER/rescore"
  check 'POST /runs/:id/rescore -> generation 2 queued, run stays scored' 200 \
    'd["status"] == "scored" and d["evaluation"]["generation"] == 2 and d["evaluation"]["cause"] == "rescore" and d["evaluation"]["status"] in ("queued", "running") and not d["joinedPending"]' \
    '"evaluation {evaluationId} gen {generation} {status}".format_map(d["evaluation"])'
  request GET "/runs/$A_LEDGER"
  check '  meanwhile the run shows generation 1 with a pending re-score (or 2 published)' 200 \
    'd["status"] == "scored" and ((d["evaluation"]["generation"] == 1 and d["evaluation"]["pending"]["generation"] == 2) or (d["evaluation"]["generation"] == 2 and d["evaluation"]["pending"] is None))' \
    '"generation {} · pending {}".format(d["evaluation"]["generation"], json.dumps(d["evaluation"]["pending"] and d["evaluation"]["pending"]["status"]))'
  if wait_for "/runs/$A_LEDGER" 'd["evaluation"]["generation"] == 2 and d["evaluation"]["pending"] is None' "$RUN_TIMEOUT"; then
    check '  generation 2 published: the same 8 results' 200 \
      'd["status"] == "scored" and len(d["scores"]) == 8 and all(s["status"] == "passed" for s in d["scores"]) and d["evaluation"]["lastFailure"] is None' \
      '"generation {} · {} passed".format(d["evaluation"]["generation"], len(d["scores"]))'
  else
    fail '  generation 2 published: the same 8 results' "$(jv 'json.dumps(d["evaluation"])' 2>/dev/null)"
  fi
  if [ "$DOCKER" = 1 ]; then
    GENS="$(psql_ro "select string_agg(e.generation || ':' || e.cause || ':' || e.status || ':' || (e.superseded_at is not null)::text || ':' || (select count(*) from scores s where s.evaluation_id = e.id), ' ' order by e.generation) from evaluations e where e.run_id = '$A_LEDGER'")"
    if [ "$GENS" = '1:initial:completed:true:8 2:rescore:completed:false:8' ]; then
      pass '  generation 1 superseded, generation 2 current, 8 rows each' "$GENS"
    else
      fail '  generation 1 superseded, generation 2 current, 8 rows each' "$GENS"
    fi
  fi
  request GET "/experiments/$EXP"
  check '  the experiment still counts each run once' 200 \
    'd["totalRuns"] == 6 and d["counts"]["scored"] == 4 and d["counts"]["cancelled"] == 2' \
    '", ".join("{} {}".format(k, v) for k, v in d["counts"].items() if v)'
fi

# A double request: two at once collapse into one evaluation.
if need 'two re-score requests at once (ledger smoke-b)' "$B_LEDGER"; then
  for n in 1 2; do
    curl -sS -o "$WORK/double-$n.json" --max-time "$CURL_TIMEOUT" -X POST -H 'X-Requested-With: phase3-smoke' \
      -H 'Content-Type: application/json' --data-binary '{}' "$BASE_URL/runs/$B_LEDGER/rescore" 2>/dev/null &
  done
  wait
  python3 - "$WORK/double-1.json" "$WORK/double-2.json" >"$WORK/double.json" <<'PY'
import json, sys
print(json.dumps([json.load(open(p)) for p in sys.argv[1:]]))
PY
  check_file 'two re-score requests at once -> one evaluation, one joined' "$WORK/double.json" \
    'd[0]["evaluation"]["evaluationId"] == d[1]["evaluation"]["evaluationId"] and d[0]["evaluation"]["generation"] == 2 and sorted([d[0]["joinedPending"], d[1]["joinedPending"]]) == [False, True]' \
    '"evaluation {} gen {} · joinedPending {} / {}".format(d[0]["evaluation"]["evaluationId"], d[0]["evaluation"]["generation"], d[0]["joinedPending"], d[1]["joinedPending"])'
  if wait_for "/runs/$B_LEDGER" 'd["evaluation"]["generation"] == 2 and d["evaluation"]["pending"] is None' "$RUN_TIMEOUT"; then
    check '  published once: generation 2, still failed' 200 \
      'all(s["status"] == "failed" for s in d["scores"]) and sc(d, "record")["score"] == 0.8' \
      '"generation {}".format(d["evaluation"]["generation"])'
  else
    fail '  published once: generation 2, still failed' "$(jv 'json.dumps(d["evaluation"])' 2>/dev/null)"
  fi
  if [ "$DOCKER" = 1 ]; then
    GENS="$(psql_ro "select string_agg(generation || ':' || status, ' ' order by generation) from evaluations where run_id = '$B_LEDGER'")"
    if [ "$GENS" = '1:completed 2:completed' ]; then
      pass '  no third evaluation' "$GENS"
    else
      fail '  no third evaluation' "$GENS"
    fi
  fi
fi

# Bulk, with a refusal: the cancelled slow run was never scored.
if need 'POST /experiments/:id/runs/rescore (bulk)' "$EXP" "$A_LEDGER" "$A_NOANSWER" "$SLOW_RUN"; then
  send_json POST "/experiments/$EXP/runs/rescore" "{\"runIds\":[\"$A_LEDGER\",\"$A_NOANSWER\",\"$SLOW_RUN\"]}"
  check 'bulk re-score: 2 enqueued, the cancelled run refused' 200 \
    'd["action"] == "rescore" and d["enqueued"] == [env["A_LEDGER"], env["A_NOANSWER"]] and [e["generation"] for e in d["evaluations"]] == [3, 2] and len(d["refused"]) == 1 and d["refused"][0]["runId"] == env["SLOW_RUN"] and "not scored" in d["refused"][0]["reason"]' \
    '"gens {} · refused: {}".format([e["generation"] for e in d["evaluations"]], d["refused"][0]["reason"])'
  if wait_for "/experiments/$EXP/runs" 'all(not r["rescorePending"] for r in d["rows"]) and sorted((r["taskKey"], r["configuration"]["name"][-1], r["generation"]) for r in d["rows"] if r["generation"]) == [("ledger", "a", 3), ("ledger", "b", 2), ("noanswer", "a", 2), ("noanswer", "b", 1)]' "$RUN_TIMEOUT"; then
    pass '  published: ledger/a gen 3, noanswer/a gen 2, results unchanged' "$(jv '", ".join("{}/{} gen {} {}".format(r["taskKey"], r["configuration"]["name"][-1], r["generation"], r["primaryScore"]["status"]) for r in d["rows"] if r["generation"])')"
  else
    fail '  published: ledger/a gen 3, noanswer/a gen 2, results unchanged' "$(jv 'json.dumps([(r["taskKey"], r["generation"], r["rescorePending"]) for r in d["rows"]])' 2>/dev/null)"
  fi
  if [ "$DOCKER" = 1 ]; then
    JUDGES_LEFT="$(egress_health judges)"
    if [ "$JUDGES_LEFT" = 0 ]; then
      pass '  after the re-scores: no judge registration left' 'judges 0'
    else
      fail '  after the re-scores: no judge registration left' "judges ${JUDGES_LEFT:-?}"
    fi
  fi
fi

# 409 while the judge's provider is not ready: the api restarted with the
# judge on OpenRouter, whose key egress does not hold, then put back.
if [ "$DOCKER" = 1 ] && [ "$SMOKE_RESTART" != 0 ] && [ -n "$ORIG_JUDGE_PROVIDER" ]; then
  if need 're-score 409 while the judge is not ready' "$A_LEDGER" "$EXP"; then
    API_JUDGE_CHANGED=1
    # A model OpenRouter does not have, and not the mock's name: env.ts reads
    # mock/scripted beside a real provider as no model (a 409 of its own).
    if api_judge openrouter smoke/no-such-model ''; then
      pass 'api recreated with JUDGE_PROVIDER=openrouter (no key)' "$(dc exec -T api sh -c 'echo "$JUDGE_PROVIDER $JUDGE_MODEL"' 2>/dev/null)"
      request GET "/runs/$A_LEDGER"
      check '  the run needs the OpenRouter judge' 200 \
        'd["needs"]["judgeProvider"] == "openrouter" and d["needs"]["judgeKeys"] == ["quality"]' 'json.dumps(d["needs"])'
      send_json POST "/runs/$A_LEDGER/rescore"
      check '  POST /runs/:id/rescore -> 409 with the reason' 409 \
        'd["statusCode"] == 409 and "quality judge" in d["message"] and "OpenRouter" in d["message"]' 'd["message"]'
      send_json POST "/experiments/$EXP/runs/rescore" "{\"runIds\":[\"$A_LEDGER\",\"$B_NOANSWER\"]}"
      check '  bulk: both refused with the judge reason' 200 \
        'd["enqueued"] == [] and len(d["refused"]) == 2 and all("judge" in r["reason"] for r in d["refused"])' 'd["refused"][0]["reason"]'
      send_json POST /experiments "$(launch_body "$PREFIX-judge-409" ledger)"
      check '  launch with an llm_judge task -> 409' 409 'd["statusCode"] == 409 and "judge" in d["message"]' 'd["message"]'
    else
      fail 'api recreated with JUDGE_PROVIDER=openrouter (no key)' "$(tail -3 "$WORK/compose.log" | tr '\n' ' ')"
    fi
    if api_judge "$ORIG_JUDGE_PROVIDER" "$ORIG_JUDGE_MODEL" "$ORIG_JUDGE_BASE_URL"; then
      API_JUDGE_CHANGED=0
      request GET "/runs/$A_LEDGER"
      check 'api put back: the judge is ready again' 200 \
        'd["needs"]["judgeProvider"] == env["ORIG_JUDGE_PROVIDER"]' '"judge " + json.dumps(d["needs"]["judgeProvider"])'
    else
      fail 'api put back: the judge is ready again' "$(tail -3 "$WORK/compose.log" | tr '\n' ' ')"
    fi
  fi
else
  skip 're-score 409 while the judge is not ready' 'needs the docker checks and SMOKE_RESTART (recreates the api)'
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
