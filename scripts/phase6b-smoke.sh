#!/usr/bin/env bash
# Phase 6b smoke test: the five sample suites on a running Hermes Evals
# stack, in real trial containers, with real Hermes against the scripted
# mock model, printing one PASS/FAIL/SKIP line per step. It covers the live
# half of Phase 6b's exit (plan 17, plan 18.5 step 3): for each suite, a
# mock-model experiment on its recommended arms completes with the verdict
# its mock scripts predict, which proves the dimension under test reaches
# the run.
#
# - the generators reproduce their bytes (scripts/fixtures/<suite>.ts
#   --check; invoices-v1.ts against the repository); with docker, mcp-v1's
#   phrases are checked against the real sample servers and Hermes's own
#   renderer in the trial image (apps/api/test/mcp-v1/hermes_render_probe.py);
# - the mock holds every scripts/*mock-scripts.json; the five suites reload
#   valid, 42 tasks, with their negative controls failing;
# - the skills (samples/skills: invoice-method, bx7-format, house-style,
#   bx6-format) validate and are stored or already are; the documents
#   (samples/documents/mcp-v1, samples/documents/knowledge-v1) are uploaded
#   under their own names, or the stored copies with the same name and
#   sha256 are reused; the sample MCP servers invoice-db and vendor-directory
#   are found or created;
# - each suite's recommended configurations (smoke-<stamp>-<suite>-<arm>)
#   and its experiment at 2 repetitions, all launched at once:
#     invoices-v1   baseline · with-skill                       better, Δ +0.667
#     mcp-v1        docs-export · with-mcp                      better, Δ +1.000 [+1.000, +1.000]
#     memory-v1     memory-off · memory-on                      better, Δ +0.625
#     knowledge-v1  none · docs, skills-preload, skills-on-demand  better, Δ +0.875 each
#     tools-v1      file · file-terminal, file-terminal-code    better, Δ +0.833 each
#   then each experiment's per-task primary results and its comparison;
# - the dimension in each run: memory-v1, every seed entry in the system
#   prompt of every memory-on request and none in memory off, unblocked by
#   Hermes's threat scan (Phase 6 decision #3), -t with the memory toolset
#   only with memory on, the saved preference collected from the home;
#   knowledge-v1, -s for the three skills preloaded, skill_view on demand,
#   the documents read from docs/, the shipped bx7.py run, the judge's style
#   score; mcp-v1, MCP calls through both servers (vendor-directory through
#   egress's gateway) in with-mcp and none in docs-export, no write tool
#   called; tools-v1, the terminal's and execute_code's results only in the
#   arms that have those tools;
# - in the mock's request log, the script that answered each run's last
#   request, task by task, is the one its suite's scripts predict.
#
#   scripts/phase6b-smoke.sh                                     # http://localhost:3000/api
#   BASE_URL=http://localhost:8080/api scripts/phase6b-smoke.sh  # through nginx
#
# The stack needs the Phase 6 images, the mock model (profile `test`) with
# every scripts/*mock-scripts.json (each script matches a phrase only its own
# suite's runs hold, so their order does not matter; apps/api/test/
# phase6b-mock-scripts.spec.ts and phase6-smoke.spec.ts check it), the mock
# as the judge (invoices-v1's disputed and knowledge-v1's house_summary have
# an llm_judge key), INVOICE_DB_URL for the worker, and the sample http MCP
# server (profile `samples`) with VENDOR_DIRECTORY_TOKEN (any random
# string). Without the last two, mcp-v1's launch answers 409 and its checks
# are skipped. Compose reads every one of them from the shell before .env,
# so no file changes:
#
#   export VENDOR_DIRECTORY_TOKEN="$(openssl rand -hex 16)" INVOICE_DB_URL=file:///opt/mcp/invoice-db/invoices.csv
#   MOCK_SCRIPTS_FILE=./scripts \
#   JUDGE_PROVIDER=custom JUDGE_MODEL=mock/scripted JUDGE_BASE_URL=http://mock-model:8090/v1 \
#     docker compose --profile test --profile samples up -d --build
#
# (Compose mounts the directory MOCK_SCRIPTS_FILE names into the mock, which
# reads every *.json file in it in name order.)
#
# Every configuration uses provider `custom` with base URL
# http://mock-model:8090/v1 and model mock/scripted, which config/prices.yaml
# prices at 0: no real provider is ever called and nothing costs money.
#
# Needs bash (3.2 is enough), curl, python3 and node (22.18+, which runs the
# TypeScript generators). Exits 0 only when no step failed. It writes to the
# stack it tests (configurations, experiments, skills, documents, the two
# sample servers), so point it at a development stack only. Names it creates
# start with smoke-<UTC timestamp>, so it can run again and again; skills,
# documents and the sample servers are reused when stored already. It
# changes nothing under suites/. On Colima, export DOCKER_CONTEXT=colima so
# the docker checks run.
#
# Settings (environment):
#   BASE_URL      API base URL (default http://localhost:3000/api)
#   SUITES_DIR    host directory the worker reads suites from (default <repo>/suites)
#   SMOKE_SUITES  the suites whose experiments run (default: all five,
#                 "invoices-v1 mcp-v1 memory-v1 knowledge-v1 tools-v1")
#   SMOKE_DOCKER  auto (default) | 0: also check, read-only through docker, the mock's
#                 scripts and its request log, and mcp-v1's render probe
#   TRIAL_IMAGE   the trial image for the probe (default hermes-evals/trial:v0.22.4-4d04303)
#   RUN_TIMEOUT   seconds the experiments may take together (default 2700)
#   CURL_TIMEOUT  seconds per request (default 120)
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000/api}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
SMOKE_SUITES="${SMOKE_SUITES:-invoices-v1 mcp-v1 memory-v1 knowledge-v1 tools-v1}"
SMOKE_DOCKER="${SMOKE_DOCKER:-auto}"
TRIAL_IMAGE="${TRIAL_IMAGE:-hermes-evals/trial:v0.22.4-4d04303}"
RUN_TIMEOUT="${RUN_TIMEOUT:-2700}"
CURL_TIMEOUT="${CURL_TIMEOUT:-120}"

STAMP="$(date -u +%Y%m%d%H%M%S)"
PREFIX="smoke-$STAMP"
# Each suite's tasks, in suite.yaml order.
TASKS_INVOICES='total_due,overdue_list,dup_invoices,vat_split,credit_notes,currency_mix,missing_po,late_fees,per_vendor,disputed,partial_pay,summary_file'
TASKS_MCP='lookup_invoice,due_by_terms,all_pages,filtered_list,not_found,read_only,injected_note,vendors_on_hold'
TASKS_MEMORY='usual_currency,vendor_alias,standing_exclusion,prompt_wins,data_wins,needle,remember_this,keep_private'
TASKS_KNOWLEDGE='closing_balance,record_counts,large_file,reason_codes,pick_version,house_summary,prompt_override,unrelated'
TASKS_TOOLS='big_csv,extract_ibans,reshape_json,checksum,join_three,small_lookup'
export REPO_DIR SUITES_DIR PREFIX TASKS_INVOICES TASKS_MCP TASKS_MEMORY TASKS_KNOWLEDGE TASKS_TOOLS

for tool in curl python3 node; do
  command -v "$tool" >/dev/null || { echo "phase6b-smoke: $tool is required" >&2; exit 2; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase6b-smoke.XXXXXX")"
export WORK
BODY="$WORK/body"
STATUS=000
PASSES=0
FAILS=0
SKIPS=0
trap 'rm -rf "$WORK"' EXIT

# runs SUITE: true when SMOKE_SUITES names the suite.
runs() { case " $SMOKE_SUITES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------------------
# Helpers (as in phase6-smoke.sh)
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
      -H 'X-Requested-With: phase6b-smoke' "$@" "$BASE_URL$path" 2>"$WORK/curl.err")" || STATUS=000
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
# scripts/phase6b-smoke-checks.py (sc, primary, runs_of, events, finals, ...).
CHECKS="$REPO_DIR/scripts/phase6b-smoke-checks.py"
export CHECKS
jv() {
  python3 - "$1" "${2:-$BODY}" <<'PY'
import json, os, sys
with open(os.environ['CHECKS'], encoding='utf-8') as f:
    exec(compile(f.read(), os.environ['CHECKS'], 'exec'))
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

line() { printf '%-5s %-74s %s\n' "$1" "$2" "$3"; }
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
# The mock's log of every request it received (GET /__requests), into FILE.
mock_requests() {
  dc exec -T mock-model node -e "fetch('http://localhost:8090/__requests').then(r=>r.text()).then(t=>process.stdout.write(t))" >"$1" 2>/dev/null
}
# mock_summary OUT: this run's part of the mock's log (from MOCK_FROM), one
# row per request: the script that answered it, the prompt, whether the step
# it played was the final answer (by the scripts of the repository, which
# the mock holds), and, for memory-v1's requests, the system prompt.
mock_summary() {
  mock_requests "$WORK/mock-raw.json" || return 1
  python3 - "$WORK/mock-raw.json" "$1" "$MOCK_FROM" "$REPO_DIR/scripts" <<'PY'
import glob, json, os, sys
raw, out, start, scripts_dir = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
steps = {}
for path in sorted(glob.glob(os.path.join(scripts_dir, '*mock-scripts.json'))):
    with open(path, encoding='utf-8') as f:
        for s in json.load(f):
            steps[s['match']] = s['steps']
def text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(p.get('text', '') for p in content if isinstance(p, dict))
    return ''
rows = []
with open(raw, encoding='utf-8') as f:
    log = json.load(f)
for x in log[start:]:
    messages = x['body'].get('messages') or []
    user = next((text(m.get('content')) for m in messages if m.get('role') == 'user'), '')
    system = text(messages[0].get('content')) if messages and messages[0].get('role') == 'system' else ''
    n = sum(1 for m in messages if m.get('role') == 'tool')
    s = steps.get(x['script']) if x['script'] else None
    final = bool(s) and 'content' in s[min(n, len(s) - 1)]
    rows.append({'script': x['script'], 'user': user, 'final': final, 'tools': n,
                 'system': system if 'Ticket mv1-t' in user else None})
with open(out, 'w', encoding='utf-8') as f:
    json.dump(rows, f)
PY
}

printf 'Phase 6b smoke · %s · stamp %s · suites: %s · docker checks: %s\n' "$BASE_URL" "$STAMP" "$SMOKE_SUITES" "$([ "$DOCKER" = 1 ] && echo on || echo off)"

# ---------------------------------------------------------------------------
section 'Generators and the mcp-v1 render probe'
# ---------------------------------------------------------------------------

for GEN in sample-mcp mcp-v1 memory-v1 knowledge-v1 tools-v1; do
  if node "$REPO_DIR/scripts/fixtures/$GEN.ts" --check >"$WORK/gen.out" 2>&1; then
    pass "$GEN.ts --check: the repository holds what it generates" "$(tail -1 "$WORK/gen.out")"
  else
    fail "$GEN.ts --check: the repository holds what it generates" "$(tail -3 "$WORK/gen.out" | tr '\n' ' ')"
  fi
done
if node "$REPO_DIR/scripts/fixtures/invoices-v1.ts" --out "$WORK/gen" >"$WORK/gen.out" 2>&1; then
  # Hand-written files (task.yaml, most prompts, verifiers) exist only in the repository.
  DIFFS="$( (diff -rq "$WORK/gen/suites/invoices-v1" "$SUITES_DIR/invoices-v1" | grep -v "^Only in $SUITES_DIR/invoices-v1") 2>&1)"
  if [ -z "$DIFFS" ] && cmp -s "$WORK/gen/scripts/phase6-mock-scripts.json" "$REPO_DIR/scripts/phase6-mock-scripts.json"; then
    pass 'invoices-v1.ts reproduces the suite and phase6-mock-scripts.json'
  else
    fail 'invoices-v1.ts reproduces the suite and phase6-mock-scripts.json' "$(printf '%s' "$DIFFS" | head -3 | tr '\n' ' ')"
  fi
else
  fail 'invoices-v1.ts reproduces the suite and phase6-mock-scripts.json' "$(tail -3 "$WORK/gen.out" | tr '\n' ' ')"
fi

if [ "$DOCKER" = 1 ] && docker image inspect "$TRIAL_IMAGE" >/dev/null 2>&1; then
  if docker run --rm --network none -v "$REPO_DIR/docker/mcp:/checks:ro" -v "$REPO_DIR/scripts:/scripts:ro" \
    -v "$REPO_DIR/apps/api/test/mcp-v1:/probe:ro" --entrypoint /opt/hermes/.venv/bin/python "$TRIAL_IMAGE" \
    /probe/hermes_render_probe.py >"$WORK/probe.out" 2>&1 && tail -1 "$WORK/probe.out" | grep -q 'all mcp-v1 phrase checks passed'; then
    pass "mcp-v1's phrases in the real servers' results, as Hermes renders them" "$(tail -1 "$WORK/probe.out")"
  else
    fail "mcp-v1's phrases in the real servers' results, as Hermes renders them" "$(tail -3 "$WORK/probe.out" | tr '\n' ' ')"
  fi
else
  skip "mcp-v1's phrases in the real servers' results, as Hermes renders them" "no docker here, or no $TRIAL_IMAGE"
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
  dc exec -T mock-model node dist/mock-model.js --print-scripts >"$WORK/mock-scripts.json" 2>/dev/null
  # Every script of every file, by its phrase: the order does not matter.
  check_file 'the mock holds every scripts/*mock-scripts.json' "$WORK/mock-scripts.json" \
    'all(s["match"] in {x["match"] for x in d} for f in __import__("glob").glob(env["REPO_DIR"] + "/scripts/*mock-scripts.json") for s in json.load(open(f)))' \
    '"{} scripts; missing: {}".format(len(d), ", ".join(sorted({os.path.basename(f) for f in __import__("glob").glob(env["REPO_DIR"] + "/scripts/*mock-scripts.json") for s in json.load(open(f)) if s["match"] not in {x["match"] for x in d}})) or "none")'
else
  skip 'the mock holds every scripts/*mock-scripts.json' 'docker compose not reachable here (or SMOKE_DOCKER=0)'
fi

# ---------------------------------------------------------------------------
section 'The five suites'
# ---------------------------------------------------------------------------

for SUITE in invoices-v1 mcp-v1 memory-v1 knowledge-v1 tools-v1; do
  send_json POST /suites/reload "{\"path\":\"./suites/$SUITE\"}"
  SUITE="$SUITE" check "reload $SUITE" 200 \
    'd["suites"][0]["name"] == env["SUITE"] and d["suites"][0]["outcome"] in ("created", "unchanged", "reverted") and d["suites"][0]["error"] is None' \
    '"{outcome} v{versionNumber}: {message}".format_map(d["suites"][0])'
done
request GET /suites
cp "$BODY" "$WORK/suites.json"
check 'the five suites: 12 + 8 + 8 + 8 + 6 tasks, every one valid' 200 \
  'sorted((s["name"], s["taskCount"], s["validCount"]) for s in d if s["name"] in ("invoices-v1", "mcp-v1", "memory-v1", "knowledge-v1", "tools-v1")) == [("invoices-v1", 12, 12), ("knowledge-v1", 8, 8), ("mcp-v1", 8, 8), ("memory-v1", 8, 8), ("tools-v1", 6, 6)]' \
  '"; ".join("{name} v{versionNumber} {validCount}/{taskCount}".format_map(s) for s in d if s["name"] in ("invoices-v1", "mcp-v1", "memory-v1", "knowledge-v1", "tools-v1"))'
suite_id() { NAME="$1" jv 'next(s["suiteId"] for s in d if s["name"] == env["NAME"])' "$WORK/suites.json" 2>/dev/null; }
INVOICES_ID="$(suite_id invoices-v1)"
MCP_ID="$(suite_id mcp-v1)"
MEMORY_ID="$(suite_id memory-v1)"
KNOWLEDGE_ID="$(suite_id knowledge-v1)"
TOOLS_ID="$(suite_id tools-v1)"
if need 'memory-v1 remember_this: its home check' "$MEMORY_ID"; then
  request GET "/suites/$MEMORY_ID/tasks/remember_this"
  check '  memory-v1 remember_this: passes on the expected home, fails on the seeds' 200 \
    'next(r for r in d["selfCheck"]["results"] if r["key"] == "saved")["note"] == "passes on the expected home; fails on the home seeds alone, as it should"' \
    'next(v["sentence"] for v in d["verification"] if v["key"] == "saved")'
fi
if need 'tools-v1 reshape_json: its negative controls' "$TOOLS_ID"; then
  request GET "/suites/$TOOLS_ID/tasks/reshape_json"
  check '  tools-v1 reshape_json: passes on the expected workspace, fails on the fixtures' 200 \
    'd["valid"] and d["selfCheck"]["status"] == "passed" and sorted(r["key"] for r in d["selfCheck"]["results"] if "fails on the untouched fixtures" in r["note"]) == ["quantities", "stock_file"]' \
    '"; ".join("{key}: {note}".format_map(r) for r in d["selfCheck"]["results"])'
fi

# ---------------------------------------------------------------------------
section 'Skills, documents and the sample MCP servers'
# ---------------------------------------------------------------------------

# upload_skill DIR NAME: zips DIR, validates, then confirms or reuses the stored copy; sets SKILL_ID.
upload_skill() {
  SKILL_ID=''
  zip_dir "$1" "$WORK/$2.zip"
  request POST /resources/skills/validate -F "file=@$WORK/$2.zip;type=application/zip"
  NAME="$2" check "skill $2: validates" 200 \
    'd["name"] == env["NAME"] and (d["outcome"] in ("valid", "new_version") or (d["outcome"] == "conflict" and d["problems"][0]["title"] == "Already uploaded."))' \
    '"{outcome} · {version} · ".format_map(d) + ", ".join(f["path"] for f in d["fileTree"])' || return 0
  if [ "$(jv 'd["outcome"]')" = conflict ]; then
    SKILL_ID="$(jv 'd["existing"]["id"]')"
    pass "  $2 is stored already with this content: reused" "$SKILL_ID"
    return 0
  fi
  send_json POST /resources/skills "{\"token\":\"$(jv 'd["token"]')\"}"
  NAME="$2" check "  skill $2: stored" 201 'd["name"] == env["NAME"]' '"{name}@{version} · {id}".format_map(d)'
  SKILL_ID="$(jv 'd["id"]' 2>/dev/null)"
}
# upload_document FILE: reuses the stored document with this name and
# sha256, else uploads it under its own name; appends its id to DOC_IDS
# (a JSON list body: "id","id").
upload_document() {
  local name sha id
  name="$(basename "$1")"
  sha="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1")"
  request GET /resources/documents
  id="$(NAME="$name" SHA="$sha" jv 'next((r["id"] for r in d if r["filename"] == env["NAME"] and r["sha256"] == env["SHA"]), "")' 2>/dev/null)"
  if [ -n "$id" ]; then
    pass "document $name: stored already, same sha256: reused" "$id"
  else
    request POST /resources/documents -F "file=@$1;filename=$name"
    NAME="$name" SHA="$sha" check "document $name: uploaded" 201 \
      'd["filename"] == env["NAME"] and d["sha256"] == env["SHA"]' '"{id} · {sizeBytes} bytes · {typeLabel}".format_map(d)' || return 0
    id="$(jv 'd["id"]' 2>/dev/null)"
  fi
  DOC_IDS="${DOC_IDS:+$DOC_IDS,}\"$id\""
}

METHOD_SKILL=''
if runs invoices-v1; then
  upload_skill "$REPO_DIR/samples/skills/invoice-method" invoice-method
  METHOD_SKILL="$SKILL_ID"
fi
KNOWLEDGE_SKILLS=''
KNOWLEDGE_DOCS=''
if runs knowledge-v1; then
  for SKILL in bx7-format house-style bx6-format; do
    upload_skill "$REPO_DIR/samples/skills/$SKILL" "$SKILL"
    [ -n "$SKILL_ID" ] && KNOWLEDGE_SKILLS="${KNOWLEDGE_SKILLS:+$KNOWLEDGE_SKILLS,}\"$SKILL_ID\""
  done
  DOC_IDS=''
  for DOC in "$REPO_DIR"/samples/documents/knowledge-v1/*; do upload_document "$DOC"; done
  KNOWLEDGE_DOCS="$DOC_IDS"
fi

MCP_DOCS=''
VENDORS_VERSION=''
LEDGER_VERSION=''
TOKEN_SET=false
INVOICE_DB_SET=false
if runs mcp-v1; then
  DOC_IDS=''
  for DOC in invoices.csv vendors.json; do upload_document "$REPO_DIR/samples/documents/mcp-v1/$DOC"; done
  MCP_DOCS="$DOC_IDS"
  # sample_server NAME DEFINITION EXPR: reuses the stored server of that name
  # when its latest version passes EXPR, updates it to DEFINITION when it does
  # not, else creates it; sets SERVER_VERSION.
  sample_server() {
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
      NAME="$1" check "MCP server $1: created" 201 "d[\"name\"] == env[\"NAME\"] and $3" '"v{version} · {transport}".format_map(d)' || return 0
    fi
    SERVER_VERSION="$(jv 'd["versionId"]' 2>/dev/null)"
  }
  # Fixed names: mcp-v1's tasks and scripts name mcp__invoice_db__* and mcp__vendor_directory__*.
  sample_server vendor-directory \
    '{"name":"vendor-directory","transport":"http","command":null,"args":[],"envNames":[],"url":"http://vendor-directory:8000/mcp","headers":[{"header":"Authorization","env":"VENDOR_DIRECTORY_TOKEN","prefix":"Bearer "}],"include":[],"exclude":[],"timeoutS":30}' \
    'd["transport"] == "http" and d["url"] == "http://vendor-directory:8000/mcp" and d["headers"] == [{"header": "Authorization", "env": "VENDOR_DIRECTORY_TOKEN", "prefix": "Bearer "}] and d["include"] == [] and d["exclude"] == []'
  VENDORS_VERSION="$SERVER_VERSION"
  sample_server invoice-db \
    '{"name":"invoice-db","transport":"stdio","command":"invoice-db-mcp","args":[],"envNames":["INVOICE_DB_URL"],"url":null,"headers":[],"include":[],"exclude":[],"timeoutS":30}' \
    'd["transport"] == "stdio" and d["command"] == "invoice-db-mcp" and d["envNames"] == ["INVOICE_DB_URL"] and d["include"] == [] and d["exclude"] == []'
  LEDGER_VERSION="$SERVER_VERSION"
  request GET /resources/secrets
  TOKEN_SET="$(jv 'next((r["set"] for r in d if r["name"] == "VENDOR_DIRECTORY_TOKEN" and r["source"] == "egress"), False)' 2>/dev/null)"
  INVOICE_DB_SET="$(jv 'next((r["set"] for r in d if r["name"] == "INVOICE_DB_URL" and r["source"] == "worker"), False)' 2>/dev/null)"
  export TOKEN_SET INVOICE_DB_SET
  check 'GET /resources/secrets: VENDOR_DIRECTORY_TOKEN (egress), INVOICE_DB_URL (worker)' 200 'True' \
    '"VENDOR_DIRECTORY_TOKEN {} · INVOICE_DB_URL {}".format(*["set" if v == "true" else "not set (mcp-v1 expects the launch 409)" for v in (env["TOKEN_SET"], env["INVOICE_DB_SET"])])'
fi
export TOKEN_SET INVOICE_DB_SET

# ---------------------------------------------------------------------------
section 'Configurations: the recommended arms, on the mock model'
# ---------------------------------------------------------------------------

# config ARM TOOLSETS MEMORY SKILL_IDS LOADING DOC_IDS MCP_IDS MAX_TURNS BUDGET:
# POST /configurations smoke-<stamp>-ARM; sets VERSION_ID.
config() {
  VERSION_ID=''
  send_json POST /configurations "$(printf '{"name":"%s","model":"mock/scripted","provider":"custom","baseUrl":"http://mock-model:8090/v1","toolsets":[%s],"memoryEnabled":%s,"skillIds":[%s],"skillLoading":"%s","documentIds":[%s],"mcpServerVersionIds":[%s],"maxTurns":%s,"timeBudgetS":%s,"duplicatedFromVersionId":null}' \
    "$PREFIX-$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9")"
  check "POST /configurations $PREFIX-$1" 201 'd["version"] == 1' '"version {version} · {versionId}".format_map(d)' || return 0
  VERSION_ID="$(jv 'd["versionId"]' 2>/dev/null)"
}
F='"file"'
FT='"file","terminal"'
FTC='"file","terminal","code_execution"'

INV_BASE='' INV_SKILL=''
if runs invoices-v1; then
  config invoices-v1-baseline "$FT" false '' preload '' '' 10 180 && INV_BASE="$VERSION_ID"
  if need "POST /configurations $PREFIX-invoices-v1-with-skill" "$METHOD_SKILL"; then
    config invoices-v1-with-skill "$FT" false "\"$METHOD_SKILL\"" preload '' '' 10 180 && INV_SKILL="$VERSION_ID"
  fi
fi
MCP_DOCS_ARM='' MCP_WITH=''
if runs mcp-v1; then
  # due_by_terms makes 18 model calls with the servers, hence 30 turns.
  if need "POST /configurations $PREFIX-mcp-v1-docs-export" "$MCP_DOCS"; then
    config mcp-v1-docs-export "$FT" false '' preload "$MCP_DOCS" '' 30 600 && MCP_DOCS_ARM="$VERSION_ID"
  fi
  if need "POST /configurations $PREFIX-mcp-v1-with-mcp" "$VENDORS_VERSION" "$LEDGER_VERSION"; then
    config mcp-v1-with-mcp "$FT" false '' preload '' "\"$LEDGER_VERSION\",\"$VENDORS_VERSION\"" 30 600 && MCP_WITH="$VERSION_ID"
  fi
fi
MEM_OFF='' MEM_ON=''
if runs memory-v1; then
  # The arms differ only in memory_enabled; memory on brings the memory toolset at launch.
  config memory-v1-memory-off "$FT" false '' preload '' '' 10 180 && MEM_OFF="$VERSION_ID"
  config memory-v1-memory-on "$FT" true '' preload '' '' 10 180 && MEM_ON="$VERSION_ID"
fi
KN_NONE='' KN_DOCS='' KN_PRE='' KN_LAZY=''
if runs knowledge-v1; then
  config knowledge-v1-none "$FT" false '' preload '' '' 10 180 && KN_NONE="$VERSION_ID"
  if need "POST /configurations $PREFIX-knowledge-v1-docs" "$KNOWLEDGE_DOCS"; then
    config knowledge-v1-docs "$FT" false '' preload "$KNOWLEDGE_DOCS" '' 10 180 && KN_DOCS="$VERSION_ID"
  fi
  if need "POST /configurations $PREFIX-knowledge-v1-skills-*" "$KNOWLEDGE_SKILLS"; then
    config knowledge-v1-skills-preload "$FT" false "$KNOWLEDGE_SKILLS" preload '' '' 10 180 && KN_PRE="$VERSION_ID"
    config knowledge-v1-skills-on-demand "$FT" false "$KNOWLEDGE_SKILLS" on_demand '' '' 10 180 && KN_LAZY="$VERSION_ID"
  fi
fi
TL_FILE='' TL_TERM='' TL_CODE=''
if runs tools-v1; then
  config tools-v1-file "$F" false '' preload '' '' 10 180 && TL_FILE="$VERSION_ID"
  config tools-v1-file-terminal "$FT" false '' preload '' '' 10 180 && TL_TERM="$VERSION_ID"
  config tools-v1-file-terminal-code "$FTC" false '' preload '' '' 10 180 && TL_CODE="$VERSION_ID"
fi

# ---------------------------------------------------------------------------
section 'Launch: each suite on its recommended arms, 2 repetitions'
# ---------------------------------------------------------------------------

request GET /experiments/new-options
cp "$BODY" "$WORK/options.json"
check 'GET /experiments/new-options' 200 'isinstance(d["configurations"], list)' '"{} configurations".format(len(d["configurations"]))'

# launch SUITE_ID NAME TASKS BASELINE CANDIDATES: POST /experiments at 2
# repetitions; CANDIDATES is a comma-separated list of version ids. The id
# lands in $EXP when the launch is accepted.
launch() {
  local body
  EXP=''
  body="$(python3 - "$WORK/options.json" "$@" <<'PY'
import json, sys
options, suite, name, tasks, baseline, candidates = sys.argv[1:7]
o = json.load(open(options))
h = {c['versionId']: c['configHash'] for c in o['configurations']}
cands = candidates.split(',')
print(json.dumps({'name': name, 'description': 'phase6b-smoke: ' + name, 'suiteId': suite,
                  'taskKeys': tasks.split(','), 'baselineVersionId': baseline, 'candidateVersionIds': cands,
                  'repetitions': 2, 'concurrency': 3, 'spendCeilingUsd': None, 'timeBudgetOverrideS': None,
                  'expectedConfigHashes': {v: h[v] for v in [baseline] + cands}}))
PY
  )" || return 0
  send_json POST /experiments "$body"
  [ "$STATUS" = 201 ] && EXP="$(jv 'd["id"]' 2>/dev/null)"
  return 0
}

# Where this run's requests start in the mock's log (it keeps every request since it started).
MOCK_FROM=0
if [ "$DOCKER" = 1 ] && mock_requests "$WORK/mock-raw.json"; then
  MOCK_FROM="$(jv 'len(d)' "$WORK/mock-raw.json" 2>/dev/null || echo 0)"
fi
export MOCK_FROM

INV_EXP='' MCP_EXP='' MEM_EXP='' KN_EXP='' TL_EXP=''
if runs invoices-v1 && need 'POST /experiments invoices-v1' "$INVOICES_ID" "$INV_BASE" "$INV_SKILL"; then
  launch "$INVOICES_ID" "$PREFIX-invoices-v1" "$TASKS_INVOICES" "$INV_BASE" "$INV_SKILL"
  check 'POST /experiments invoices-v1: 12 tasks x baseline, with-skill x 2' 201 'bool(d["id"])' '"experiment " + d["id"] + " (a 409 here: is the judge set? see the header)"'
  INV_EXP="$EXP"
fi
if runs mcp-v1 && need 'POST /experiments mcp-v1' "$MCP_ID" "$MCP_DOCS_ARM" "$MCP_WITH"; then
  launch "$MCP_ID" "$PREFIX-mcp-v1" "$TASKS_MCP" "$MCP_DOCS_ARM" "$MCP_WITH"
  if [ "$TOKEN_SET" = true ] && [ "$INVOICE_DB_SET" = true ]; then
    check 'POST /experiments mcp-v1: 8 tasks x docs-export, with-mcp x 2' 201 'bool(d["id"])' '"experiment " + d["id"]'
    MCP_EXP="$EXP"
  else
    check 'POST /experiments mcp-v1 without a sample variable -> 409 naming it' 409 \
      '"VENDOR_DIRECTORY_TOKEN" in d["message"] or "INVOICE_DB_URL" in d["message"]' 'd["message"]'
  fi
fi
if runs memory-v1 && need 'POST /experiments memory-v1' "$MEMORY_ID" "$MEM_OFF" "$MEM_ON"; then
  launch "$MEMORY_ID" "$PREFIX-memory-v1" "$TASKS_MEMORY" "$MEM_OFF" "$MEM_ON"
  check 'POST /experiments memory-v1: 8 tasks x memory-off, memory-on x 2' 201 'bool(d["id"])' '"experiment " + d["id"]'
  MEM_EXP="$EXP"
fi
if runs knowledge-v1 && need 'POST /experiments knowledge-v1' "$KNOWLEDGE_ID" "$KN_NONE" "$KN_DOCS" "$KN_PRE" "$KN_LAZY"; then
  launch "$KNOWLEDGE_ID" "$PREFIX-knowledge-v1" "$TASKS_KNOWLEDGE" "$KN_NONE" "$KN_DOCS,$KN_PRE,$KN_LAZY"
  check 'POST /experiments knowledge-v1: 8 tasks x none, docs, preload, on demand x 2' 201 'bool(d["id"])' '"experiment " + d["id"] + " (a 409 here: is the judge set? see the header)"'
  KN_EXP="$EXP"
fi
if runs tools-v1 && need 'POST /experiments tools-v1' "$TOOLS_ID" "$TL_FILE" "$TL_TERM" "$TL_CODE"; then
  launch "$TOOLS_ID" "$PREFIX-tools-v1" "$TASKS_TOOLS" "$TL_FILE" "$TL_TERM,$TL_CODE"
  check 'POST /experiments tools-v1: 6 tasks x file, file-terminal, file-terminal-code x 2' 201 'bool(d["id"])' '"experiment " + d["id"]'
  TL_EXP="$EXP"
fi

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
# details RUNS OUT: the detail of every run in the run list RUNS, as one JSON list in OUT.
details() {
  local id
  rm -rf "$WORK/details"
  mkdir -p "$WORK/details"
  jv '"\n".join(r["id"] for r in d["rows"])' "$1" >"$WORK/ids" 2>/dev/null || return 1
  while read -r id; do
    [ -n "$id" ] || continue
    request GET "/runs/$id"
    [ "$STATUS" = 200 ] || { fail "GET /runs/$id" "HTTP $STATUS"; return 1; }
    cp "$BODY" "$WORK/details/$id.json"
  done <"$WORK/ids"
  python3 - "$WORK/details" "$2" <<'PY'
import json, os, sys
src, out = sys.argv[1], sys.argv[2]
runs = []
for name in sorted(os.listdir(src)):
    with open(os.path.join(src, name), encoding='utf-8') as f:
        runs.append(json.load(f))
with open(out, 'w', encoding='utf-8') as f:
    json.dump(runs, f)
PY
}
# primaries NAME RUNS PRED: each task's primary status under each arm, both
# repetitions alike, is the one PRED (JSON {arm: {task: status}}) gives.
primaries() {
  PRED="$3" check_file "$1" "$2" 'primaries_ok(d, json.loads(env["PRED"]))' 'primaries_line(d, json.loads(env["PRED"]))'
}
# comparison NAME EXP CANDIDATE WANT: the comparison of CANDIDATE against
# the baseline reads WANT (JSON: verdict, delta, lo when exact, changes
# [improved, regressed, unchanged], passes [[passed, counted] baseline, candidate]).
comparison() {
  request GET "/experiments/$2/comparison?candidate=$3"
  WANT="$4" check "$1" 200 'comparison_ok(d, want())' 'comparison_line(d)'
}
# pred ARM=STATUS-FOR-ALL [TASK=STATUS ...] over TASKS: a PRED row.
pred() {
  python3 - "$@" <<'PY'
import json, sys
tasks, arm, default = sys.argv[1].split(','), sys.argv[2], sys.argv[3]
row = {t: default for t in tasks}
for pair in sys.argv[4:]:
    t, s = pair.split('=')
    row[t] = s
print(json.dumps({arm: row}))
PY
}
# merge JSON...: one PRED from several rows.
merge() { python3 -c 'import json, sys; out = {}; [out.update(json.loads(a)) for a in sys.argv[1:]]; print(json.dumps(out))' "$@"; }

# ---------------------------------------------------------------------------
section 'invoices-v1: the skill against its traps'
# ---------------------------------------------------------------------------

if ! runs invoices-v1; then
  skip 'invoices-v1 experiment' 'not in SMOKE_SUITES'
elif need 'invoices-v1 experiment' "$INV_EXP" && settles 'invoices-v1' "$INV_EXP" 48 "$WORK/invoices-runs.json"; then
  primaries 'with-skill passes all 12; baseline passes 4 and falls into 8 traps' "$WORK/invoices-runs.json" \
    "$(merge "$(pred "$TASKS_INVOICES" invoices-v1-with-skill passed)" \
      "$(pred "$TASKS_INVOICES" invoices-v1-baseline failed total_due=passed overdue_list=passed vat_split=passed missing_po=passed)")"
  comparison 'invoices-v1 comparison: better, Δ +0.667, 8 improved, 4 unchanged' "$INV_EXP" "$INV_SKILL" \
    '{"verdict": "better", "delta": 0.667, "changes": [8, 0, 4], "passes": [[8, 24], [24, 24]]}'
  for ARM in baseline with-skill; do
    RUN="$(TASK=disputed ARM="invoices-v1-$ARM" jv 'next(r["id"] for r in d["rows"] if r["taskKey"] == env["TASK"] and r["configuration"]["name"] == cfg(env["ARM"]))' "$WORK/invoices-runs.json" 2>/dev/null)"
    if need "  disputed under $ARM: the judge's method score" "$RUN"; then
      request GET "/runs/$RUN"
      WANT="$([ "$ARM" = with-skill ] && echo 0.9 || echo 0.2)" check "  disputed under $ARM: method scored $([ "$ARM" = with-skill ] && echo 0.9 || echo 0.2) by the mock judge" 200 \
        'sc(d, "method")["score"] == float(env["WANT"])' '"method {status} {score}".format_map(sc(d, "method"))'
    fi
  done
fi

# ---------------------------------------------------------------------------
section 'mcp-v1: the same data through MCP and as documents'
# ---------------------------------------------------------------------------

if ! runs mcp-v1; then
  skip 'mcp-v1 experiment' 'not in SMOKE_SUITES'
elif [ "$TOKEN_SET" != true ] || [ "$INVOICE_DB_SET" != true ]; then
  skip 'mcp-v1 experiment' 'a sample variable is not set: the launch 409 above stands in (see the header)'
elif need 'mcp-v1 experiment' "$MCP_EXP" && settles 'mcp-v1' "$MCP_EXP" 32 "$WORK/mcp-runs.json"; then
  primaries 'with-mcp passes all 8; docs-export fails all 8 (its trap answers)' "$WORK/mcp-runs.json" \
    "$(merge "$(pred "$TASKS_MCP" mcp-v1-with-mcp passed)" "$(pred "$TASKS_MCP" mcp-v1-docs-export failed)")"
  comparison 'mcp-v1 comparison: better, Δ +1.000 [+1.000, +1.000], 8 improved' "$MCP_EXP" "$MCP_WITH" \
    '{"verdict": "better", "delta": 1.0, "lo": 1.0, "changes": [8, 0, 0], "passes": [[0, 16], [16, 16]]}'
  if details "$WORK/mcp-runs.json" "$WORK/mcp.json"; then
    check_file '  every secondary key passes in both arms (MCP keys by absence in docs-export)' "$WORK/mcp.json" \
      'len(d) == 32 and all(s["status"] == "passed" for r in d for s in r["scores"] if not s["primary"])' \
      '", ".join(sorted({"{}.{}:{}".format(r["task"]["key"], s["key"], s["status"]) for r in d for s in r["scores"] if not s["primary"] and s["status"] != "passed"})) or "all passed"'
    check_file '  docs-export: docs/invoices.csv read; no MCP tool and no MCP gateway call' "$WORK/mcp.json" \
      'all(any("docs/invoices.csv" in (e["input"] or "") for e in events(r) if e["title"] == "read_file") and not mcp_events(r) and not any(e["network"]["kind"] == "mcp" for e in events(r, "network")) for r in runs_of(d, "mcp-v1-docs-export"))' \
      '"{} runs".format(len(runs_of(d, "mcp-v1-docs-export")))'
    check_file '  with-mcp: every run calls its MCP tools, with results that are not errors' "$WORK/mcp.json" \
      'all(mcp_events(r) and all(not e["error"] for e in mcp_events(r) if not (r["task"]["key"] == "not_found" and e["title"] == "get_invoice")) for r in runs_of(d, "mcp-v1-with-mcp"))' \
      '"; ".join("{}: {}".format(t, ", ".join(sorted({"{}.{}".format(e["server"], e["title"]) for r in runs_of(d, "mcp-v1-with-mcp", t) for e in mcp_events(r)}))) for t in tasks("MCP"))'
    check_file '  with-mcp due_by_terms: stdio and http in one run, vendor-directory through egress (200)' "$WORK/mcp.json" \
      'all({e["server"] for e in mcp_events(r)} == {"invoice-db", "vendor-directory"} and any(e["network"]["kind"] == "mcp" and e["network"]["server"] == "vendor-directory" and e["network"]["status"] == 200 for e in events(r, "network")) for r in runs_of(d, "mcp-v1-with-mcp", "due_by_terms"))' \
      '"; ".join("{} get_invoice, {} get_vendor".format(sum(e["title"] == "get_invoice" for e in mcp_events(r)), sum(e["title"] == "get_vendor" for e in mcp_events(r))) for r in runs_of(d, "mcp-v1-with-mcp", "due_by_terms"))'
    check_file '  no run calls update_invoice or delete_invoice' "$WORK/mcp.json" \
      'not any(e["title"] in ("update_invoice", "delete_invoice") for r in d for e in events(r))'
  fi
fi

# ---------------------------------------------------------------------------
section 'memory-v1: memory off against memory on, the same seeds'
# ---------------------------------------------------------------------------

if ! runs memory-v1; then
  skip 'memory-v1 experiment' 'not in SMOKE_SUITES'
elif need 'memory-v1 experiment' "$MEM_EXP" && settles 'memory-v1' "$MEM_EXP" 32 "$WORK/memory-runs.json"; then
  primaries 'memory on passes all 8; memory off only the 3 where memory can only mislead' "$WORK/memory-runs.json" \
    "$(merge "$(pred "$TASKS_MEMORY" memory-v1-memory-on passed)" \
      "$(pred "$TASKS_MEMORY" memory-v1-memory-off failed prompt_wins=passed data_wins=passed keep_private=passed)")"
  comparison 'memory-v1 comparison: better, Δ +0.625, 5 improved, 3 unchanged' "$MEM_EXP" "$MEM_ON" \
    '{"verdict": "better", "delta": 0.625, "changes": [5, 0, 3], "passes": [[6, 16], [16, 16]]}'
  if details "$WORK/memory-runs.json" "$WORK/memory.json"; then
    check_file '  -t file,memory,terminal with memory on, file,terminal off; the seeds in every home' "$WORK/memory.json" \
      'len(d) == 32 and all(toolsets(r) == ("file,memory,terminal" if r["configuration"]["name"] == cfg("memory-v1-memory-on") else "file,terminal") and [s["path"] for s in r["launchRecord"]["homeSeeds"]] == ["memories/MEMORY.md", "memories/USER.md"] for r in d)' \
      '"; ".join(sorted({"{} -t {}".format(r["configuration"]["name"][len(env["PREFIX"]) + 1:], toolsets(r)) for r in d}))'
    check_file '  remember_this, memory on: saved to USER.md (root home), the memory tool, no lock file' "$WORK/memory.json" \
      'all((artifact(r, "home/memories/USER.md") or {}).get("origin") == "home_seed_modified" and sc(r, "saved")["status"] == "passed" and sc(r, "saved")["comment"].startswith("saved in memories/USER.md: Copy ap-approvals@") and sc(r, "used_memory")["status"] == "passed" and not any(a["path"].endswith(".lock") for a in r["artifacts"]["items"]) for r in runs_of(d, "memory-v1-memory-on", "remember_this"))' \
      'sc(runs_of(d, "memory-v1-memory-on", "remember_this")[0], "saved")["comment"]'
    check_file '  remember_this, memory off: USER.md as seeded, preferences.md written instead; both keys fail' "$WORK/memory.json" \
      'all((artifact(r, "home/memories/USER.md") or {}).get("origin") == "home_seed_unchanged" and (artifact(r, "workspace/preferences.md") or {}).get("origin") == "agent" and sc(r, "saved")["status"] == "failed" and sc(r, "used_memory")["status"] == "failed" for r in runs_of(d, "memory-v1-memory-off", "remember_this"))' \
      'sc(runs_of(d, "memory-v1-memory-off", "remember_this")[0], "saved")["comment"]'
    check_file '  currency keys: usual_currency on only, prompt_wins in both; keep_private signs from memory' "$WORK/memory.json" \
      'all(sc(r, "currency")["status"] == ("passed" if r["configuration"]["name"] == cfg("memory-v1-memory-on") else "failed") for r in runs_of(d, "memory-v1-memory-on", "usual_currency") + runs_of(d, "memory-v1-memory-off", "usual_currency")) and all(sc(r, "currency")["status"] == "passed" for r in runs_of(d, "memory-v1-memory-on", "prompt_wins") + runs_of(d, "memory-v1-memory-off", "prompt_wins")) and all("Ines, Accounts Payable, Quellbrook Instruments" in r["finalResponse"]["text"] for r in runs_of(d, "memory-v1-memory-on", "keep_private"))'
  fi
fi

# ---------------------------------------------------------------------------
section 'knowledge-v1: none against documents, skills preloaded and on demand'
# ---------------------------------------------------------------------------

STATEMENT_TASKS='["closing_balance", "record_counts", "large_file", "reason_codes", "pick_version", "house_summary", "prompt_override"]'
export STATEMENT_TASKS
if ! runs knowledge-v1; then
  skip 'knowledge-v1 experiment' 'not in SMOKE_SUITES'
elif need 'knowledge-v1 experiment' "$KN_EXP" && settles 'knowledge-v1' "$KN_EXP" 64 "$WORK/knowledge-runs.json"; then
  primaries 'every knowledge arm passes all 8; none passes only unrelated' "$WORK/knowledge-runs.json" \
    "$(merge "$(pred "$TASKS_KNOWLEDGE" knowledge-v1-none failed unrelated=passed)" "$(pred "$TASKS_KNOWLEDGE" knowledge-v1-docs passed)" \
      "$(pred "$TASKS_KNOWLEDGE" knowledge-v1-skills-preload passed)" "$(pred "$TASKS_KNOWLEDGE" knowledge-v1-skills-on-demand passed)")"
  for PAIR in "docs:$KN_DOCS" "skills-preload:$KN_PRE" "skills-on-demand:$KN_LAZY"; do
    comparison "knowledge-v1 comparison, ${PAIR%%:*}: better, Δ +0.875, 7 improved" "$KN_EXP" "${PAIR#*:}" \
      '{"verdict": "better", "delta": 0.875, "changes": [7, 0, 1], "passes": [[2, 16], [16, 16]]}'
  done
  if details "$WORK/knowledge-runs.json" "$WORK/knowledge.json"; then
    check_file '  house_summary: the judge scores the style 0.9 with knowledge, 0.2 without' "$WORK/knowledge.json" \
      'all(sc(r, "style")["score"] == (0.2 if r["configuration"]["name"] == cfg("knowledge-v1-none") else 0.9) for r in d if r["task"]["key"] == "house_summary")' \
      '"; ".join(sorted({"{} {}".format(r["configuration"]["name"][len(env["PREFIX"]) + 1:], sc(r, "style")["score"]) for r in d if r["task"]["key"] == "house_summary"}))'
    check_file '  title_format, date_format and runs_program pass only with knowledge' "$WORK/knowledge.json" \
      'all(sc(r, k)["status"] == ("failed" if r["configuration"]["name"] == cfg("knowledge-v1-none") else "passed") for r in d for k, t in (("title_format", "house_summary"), ("date_format", "house_summary"), ("runs_program", "large_file")) if r["task"]["key"] == t)'
    check_file '  preload: -s bx6-format, bx7-format, house-style; -t file,terminal; no skill_view' "$WORK/knowledge.json" \
      'all(preloaded(r) == ["bx6-format", "bx7-format", "house-style"] and toolsets(r) == "file,terminal" and not outputs(r, "skill_view") for r in runs_of(d, "knowledge-v1-skills-preload"))'
    check_file '  on demand: no -s, -t file,skills,terminal, skill_view brings bx7-format' "$WORK/knowledge.json" \
      'all(preloaded(r) == [] and toolsets(r) == "file,skills,terminal" and (r["task"]["key"] not in json.loads(env["STATEMENT_TASKS"]) or any("kv1-bx7-format" in o for o in outputs(r, "skill_view"))) for r in runs_of(d, "knowledge-v1-skills-on-demand"))'
    check_file '  docs: no -s; docs/bx7-spec.md read from the workspace' "$WORK/knowledge.json" \
      'all(preloaded(r) == [] and (r["task"]["key"] not in json.loads(env["STATEMENT_TASKS"]) or any("docs/bx7-spec.md" in (e["input"] or "") and "kv1-bx7-format" in (e["output"] or "") for e in events(r) if e["title"] == "read_file")) for r in runs_of(d, "knowledge-v1-docs"))'
    check_file '  the shipped bx7.py ran in every knowledge arm, never in none' "$WORK/knowledge.json" \
      'all(any("BX-7 reader report" in o for o in outputs(r, "terminal")) == (r["configuration"]["name"] != cfg("knowledge-v1-none")) for r in d if r["task"]["key"] in json.loads(env["STATEMENT_TASKS"]))'
  fi
fi

# ---------------------------------------------------------------------------
section 'tools-v1: file against file + terminal and file + terminal + code_execution'
# ---------------------------------------------------------------------------

TOOL_TASKS='["big_csv", "extract_ibans", "reshape_json", "checksum", "join_three"]'
export TOOL_TASKS
if ! runs tools-v1; then
  skip 'tools-v1 experiment' 'not in SMOKE_SUITES'
elif need 'tools-v1 experiment' "$TL_EXP" && settles 'tools-v1' "$TL_EXP" 36 "$WORK/tools-runs.json"; then
  primaries 'both tool arms pass all 6; file passes only small_lookup' "$WORK/tools-runs.json" \
    "$(merge "$(pred "$TASKS_TOOLS" tools-v1-file failed small_lookup=passed)" "$(pred "$TASKS_TOOLS" tools-v1-file-terminal passed)" \
      "$(pred "$TASKS_TOOLS" tools-v1-file-terminal-code passed)")"
  for PAIR in "file-terminal:$TL_TERM" "file-terminal-code:$TL_CODE"; do
    comparison "tools-v1 comparison, ${PAIR%%:*}: better, Δ +0.833, 5 improved" "$TL_EXP" "${PAIR#*:}" \
      '{"verdict": "better", "delta": 0.833, "changes": [5, 0, 1], "passes": [[2, 12], [12, 12]]}'
  done
  if details "$WORK/tools-runs.json" "$WORK/tools.json"; then
    check_file '  -t file / file,terminal / code_execution,file,terminal' "$WORK/tools.json" \
      'len(d) == 36 and all(toolsets(r) == {"tools-v1-file": "file", "tools-v1-file-terminal": "file,terminal", "tools-v1-file-terminal-code": "code_execution,file,terminal"}[r["configuration"]["name"][len(env["PREFIX"]) + 1:]] for r in d)'
    check_file '  file: no terminal or code result in any run' "$WORK/tools.json" \
      'all(not any(outcome(r["task"]["key"], k) in o for k in ("code", "term") for o in outputs(r)) for r in runs_of(d, "tools-v1-file") if r["task"]["key"] in json.loads(env["TOOL_TASKS"]))'
    check_file '  file-terminal: the terminal printed each answer; no code result' "$WORK/tools.json" \
      'all(any(outcome(r["task"]["key"], "term") in o for o in outputs(r, "terminal")) and not any(outcome(r["task"]["key"], "code") in o for o in outputs(r)) for r in runs_of(d, "tools-v1-file-terminal") if r["task"]["key"] in json.loads(env["TOOL_TASKS"]))'
    check_file '  file-terminal-code: execute_code printed each answer; no terminal result' "$WORK/tools.json" \
      'all(any(outcome(r["task"]["key"], "code") in o for o in outputs(r, "execute_code")) and not any(outcome(r["task"]["key"], "term") in o for o in outputs(r)) for r in runs_of(d, "tools-v1-file-terminal-code") if r["task"]["key"] in json.loads(env["TOOL_TASKS"]))'
    check_file '  reshape_json: stock_by_sku.json written; the quantities verifier passes with tools only' "$WORK/tools.json" \
      'all((artifact(r, "workspace/stock_by_sku.json") or {}).get("origin") == "agent" and sc(r, "quantities")["status"] == ("failed" if r["configuration"]["name"] == cfg("tools-v1-file") else "passed") for r in d if r["task"]["key"] == "reshape_json")'
  fi
fi

# ---------------------------------------------------------------------------
section "The mock's request log: the script that answered each run's last request"
# ---------------------------------------------------------------------------

if [ "$DOCKER" != 1 ]; then
  skip "the mock's request log" 'docker compose not reachable here (or SMOKE_DOCKER=0)'
elif ! mock_summary "$WORK/mock.json"; then
  fail "the mock's request log" 'could not read it'
else
  # finals SUITE FIND EXP: the tally of each task's last requests is the one its scripts predict.
  finals() {
    if [ -z "$3" ]; then
      skip "  $1: each run's last request" 'its experiment did not run'
      return 0
    fi
    SUITE="$1" FIND="$2" check_file "  $1: each run's last request picked the predicted script" "$WORK/mock.json" \
      'finals(d, globals()[env["FIND"]]) == expected_finals(env["SUITE"])' \
      '"; ".join("{}: {}".format(t, ", ".join("{} x{}".format(k[:40], n) for k, n in sorted(row.items()))) for t, row in sorted(finals(d, globals()[env["FIND"]]).items()) if row != expected_finals(env["SUITE"]).get(t)) or "every task as predicted"'
  }
  finals mcp-v1 find_mcp "$MCP_EXP"
  finals memory-v1 find_memory "$MEM_EXP"
  finals knowledge-v1 find_knowledge "$KN_EXP"
  finals tools-v1 find_tools "$TL_EXP"
  if [ -n "$MEM_EXP" ]; then
    # Phase 6 decision #3: every seed reaches the prompt with memory on, none blocked by Hermes's threat scan.
    check_file '  memory-v1: every seed entry in the system prompt with memory on, unblocked; none off' "$WORK/mock.json" \
      'seeds_ok(d)' \
      '"{} memory-on requests carried every entry of their seeds; {} memory-off requests none".format(sum(1 for x in d if find_memory(x["user"]) and x["script"].startswith("ref mv1-s")), sum(1 for x in d if find_memory(x["user"]) and x["script"].startswith("Ticket mv1-t")))'
  fi
  if [ -n "$KN_EXP" ]; then
    check_file '  knowledge-v1: the judge answered both review styles' "$WORK/mock.json" \
      '{x["script"] for x in d if x["script"] in [s["match"] for s in scripts("knowledge-v1")[:2]]} == {s["match"] for s in scripts("knowledge-v1")[:2]}'
  fi
fi

printf '\n%d passed, %d failed, %d skipped\n' "$PASSES" "$FAILS" "$SKIPS"
[ "$FAILS" -eq 0 ]
