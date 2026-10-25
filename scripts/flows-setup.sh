#!/usr/bin/env bash
# Sets up the manual walk of Flows A to D (docs/flows.md) on a development
# stack with the scripted mock model. It writes files only and calls no API:
# what the flows do through the UI (the skill upload, the MCP server, the
# configurations, the experiments) is left to the person walking them.
#
# It writes, all named with one UTC stamp so it can run again and again:
#
# - suites/zz-smoke-flows-<stamp>, seven tasks: north, south, east and west
#   (the Phase 4 smoke tasks, answered by scripts/phase4-mock-scripts.json),
#   open_eur and cobalt (the invoice-db MCP server helps the first and
#   misleads the second), and late_fees (a verifier_script check, the one
#   Flow D breaks);
# - <out>/smoke-<stamp>-stats-method.zip, the skill Flow A uploads; its
#   SKILL.md holds the phrase the Phase 4 scripts answer right;
# - <out>/mock-scripts.json: this walk's scripts, then Phase 4, 3 and 2, for
#   MOCK_SCRIPTS. The MCP scripts call the tools of the server Flow C defines,
#   smoke-<stamp>-invoice-db, by the names Hermes gives them
#   (mcp__smoke_<stamp>_invoice_db__list_invoices);
# - <out>/names.txt: every name the flows type, and the commands below.
#
#   scripts/flows-setup.sh            # stamp now, <out> = $TMPDIR/hermes-flows-<stamp>
#   FLOWS_OUT=/some/dir scripts/flows-setup.sh
#
# Then start the mock with the scripts (Compose reads the shell before .env)
# and give the worker the sample server's data file, if .env has no
# INVOICE_DB_URL (see .env.example):
#
#   MOCK_SCRIPTS="$(cat <out>/mock-scripts.json)" docker compose --profile test up -d
#
# The suite directory is the walk's to remove at the end (docs/flows.md,
# "Afterwards"). Needs bash and python3.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITES_DIR="${SUITES_DIR:-$REPO_DIR/suites}"
STAMP="${FLOWS_STAMP:-$(date -u +%Y%m%d%H%M%S)}"
OUT="${FLOWS_OUT:-${TMPDIR:-/tmp}/hermes-flows-$STAMP}"
OUT="${OUT%/}"
SUITE_NAME="zz-smoke-flows-$STAMP"
SUITE_DIR="$SUITES_DIR/$SUITE_NAME"

command -v python3 >/dev/null || { echo "flows-setup: python3 is required" >&2; exit 2; }
[ -e "$SUITE_DIR" ] && { echo "flows-setup: $SUITE_DIR already exists" >&2; exit 2; }
mkdir -p "$OUT"

python3 - "$REPO_DIR" "$SUITE_DIR" "$SUITE_NAME" "$STAMP" "$OUT" <<'PY'
import json, os, sys, zipfile
repo, root, suite, stamp, out = sys.argv[1:6]
prefix = 'smoke-' + stamp
server = prefix + '-invoice-db'
# Hermes names an MCP tool mcp__<server, every non-alphanumeric as _>__<tool>.
tool = 'mcp__' + ''.join(c if c.isalnum() else '_' for c in server) + '__list_invoices'
fenced = '\n\nEnd your reply with a fenced JSON block:\n\n```json\n{}\n```\n'

def put(path, text):
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, 'w', encoding='utf-8') as f:
        f.write(text)

def limits(toolsets):
    return 'limits:\n  max_turns: 10\n  run_budget_seconds: 120\n  toolsets_needed: [{}]\n'.format(toolsets)

put('suite.yaml', "name: {}\nversion_label: '0.1'\n"
    'description: Flows A to D (docs/flows.md), graded against the scripted mock model.\n'
    'tasks: [north, south, east, west, open_eur, cobalt, late_fees]\n'.format(suite))

# The Phase 4 smoke tasks, word for word, so scripts/phase4-mock-scripts.json answers them:
# without the skill north, south and east are wrong; with it every total is right.
amounts = ('id,region,amount,status\nN1,north,100.00,open\nN2,north,250.50,paid\nN3,north,49.50,open\n'
           'S1,south,75.25,open\nS2,south,20.00,paid\nE1,east,1000.00,open\nE2,east,42.50,open\n'
           'W1,west,12.00,open\nW2,west,8.00,paid\n')
for region, total in {'north': 149.5, 'south': 75.25, 'east': 1042.5, 'west': 12.0}.items():
    usd = region == 'west'
    put(region + '/task.yaml', 'summary: The open {} amount in amounts.csv\n'.format(region) + limits('terminal') +
        'answer:\n  format: fenced_json\n  path: {}\n'.format(region) +
        'verification:\n'
        '  - key: total\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n'
        '  - key: note\n    type: text_match\n    params: { path: note, contains: ' +
        ('[open rows, USD]' if usd else '[open rows]') + ' }\n')
    put(region + '/prompt.md',
        'Smoke stats task {}. Add up the `amount` of the open rows of `amounts.csv` whose region is {}. '
        'In `note`, say which rows you counted{}.\n\nEnd your reply with a fenced JSON block:\n\n'
        '```json\n{{ "{}": 0.0, "note": "" }}\n```\n'.format(
            region.upper(), region, ' and the currency: the west amounts are in USD' if usd else '', region))
    put(region + '/fixtures/amounts.csv', amounts)
    put(region + '/reference.json', json.dumps(
        {region: total, 'note': 'Only the open rows count' + (', in USD.' if usd else '.')}, indent=2) + '\n')

# open_eur: only the invoice database has the invoices, so only the arm with the server answers.
put('open_eur/task.yaml', 'summary: The open EUR invoices in the invoice database\n' + limits('terminal') +
    'answer:\n  format: fenced_json\n  path: total\n'
    'verification:\n'
    '  - key: total\n    type: numeric_tolerance\n    primary: true\n    params: {{ abs: 0.01 }}\n'
    '  - key: uses_db\n    type: trajectory_match\n    params: {{ tool: {}, min_calls: 1 }}\n'.format(tool))
put('open_eur/prompt.md', 'Smoke flows task OPEN-EUR. Add up the `amount` of the open invoices in EUR. '
    'They are in the invoice database (the invoice-db MCP server, tool list_invoices), if you have it; '
    '`notes.txt` says the same.' + fenced.format('{ "total": 0.0 }'))
put('open_eur/fixtures/notes.txt', 'The invoices are kept in the invoice database, not in this workspace.\n')
put('open_eur/reference.json', '{ "total": 5740.5 }\n')

# cobalt: the workspace statement is right; the database misses the credit note.
put('cobalt/task.yaml', 'summary: What is still owed to Cobalt after its credit note\n' + limits('terminal') +
    'answer:\n  format: fenced_json\n  path: total\n'
    'verification:\n  - key: total\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n')
put('cobalt/prompt.md', 'Smoke flows task COBALT. How much do we still owe Cobalt Software, in USD? '
    '`cobalt.csv` in your workspace is their statement after the credit note; the invoice database '
    'may list their invoices too.' + fenced.format('{ "total": 0.0 }'))
put('cobalt/fixtures/cobalt.csv', 'ref,amount,currency,kind\nCS-77,7800.00,USD,invoice\nCN-12,-3900.00,USD,credit note\n')
put('cobalt/reference.json', '{ "total": 3900.0 }\n')

# late_fees: a verifier script reads policy_terms.json; Flow D renames its key.
put('late_fees/task.yaml', 'summary: The late fee on 1000.00 one month late\n' + limits('terminal') +
    'answer:\n  format: fenced_json\n  path: fee\n'
    'verification:\n'
    '  - key: fee\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n'
    '  - key: rule\n    type: verifier_script\n    params: { script: check_late_fees.py }\n')
put('late_fees/prompt.md', 'Smoke flows task LATE-FEES. `policy_terms.json` in your workspace gives the monthly '
    'late fee rate. What is the late fee on an invoice of 1000.00 that is one month late?' + fenced.format('{ "fee": 0.0 }'))
put('late_fees/fixtures/policy_terms.json', '{\n  "late_fee_rate": 0.015,\n  "grace_days": 30\n}\n')
put('late_fees/reference.json', '{ "fee": 15.0 }\n')
put('late_fees/verify/check_late_fees.py', '''"""The answer's fee must be 1000.00 at the policy's monthly rate."""
import argparse
import json
import os

parser = argparse.ArgumentParser()
parser.add_argument('--answer', required=True)
parser.add_argument('--workspace', required=True)
args = parser.parse_args()

with open(args.answer, encoding='utf-8') as f:
    answer = json.load(f)
with open(os.path.join(args.workspace, 'policy_terms.json'), encoding='utf-8') as f:
    terms = json.load(f)

rate = terms['late_fee_rate']
want = round(1000 * rate, 2)
got = answer.get('fee') if isinstance(answer, dict) else None
ok = isinstance(got, (int, float)) and abs(got - want) < 0.005
print(json.dumps({'score': 1 if ok else 0, 'comment': 'fee {} against {} at {} a month'.format(got, want, rate)}))
''')

# The skill Flow A uploads.
skill = prefix + '-stats-method'
with zipfile.ZipFile(os.path.join(out, skill + '.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(skill + '/SKILL.md', '---\nname: {}\nversion: 1.0.0\ndescription: How to total one region of a ledger.\n'
               '---\n\n# Stats method\n\nsmoke-stats-method: count only the open rows of the region the task names. '
               'Paid rows never count.\n'.format(skill))

# The mock's scripts: first match wins. The two after a database answer come first, matched on
# invoice numbers only that answer holds (never the prompt, a fixture or a tool call's arguments).
call = lambda args: {'tool': tool, 'arguments': args}
cat = lambda path: {'tool': 'terminal', 'arguments': {'command': 'cat ' + path}}
say = lambda text, answer: {'content': text + '\n\n```json\n' + json.dumps(answer) + '\n```'}
flows = [
    {'match': 'INV-1004', 'steps': [call({}), say(
        'The open EUR invoices are INV-1002 (980.50), INV-1003 (4200.00) and INV-1008 (560.00): 5740.50.',
        {'total': 5740.5})]},
    {'match': 'INV-1005', 'steps': [call({'vendor_name': 'Cobalt Software'}), say(
        'The invoice database lists two open Cobalt Software invoices of 7800.00 USD: 15600.00.',
        {'total': 15600.0})]},
    {'match': 'Smoke flows task OPEN-EUR', 'steps': [call({}), say(
        'I have no invoice database to read, so I cannot total the invoices.', {'total': 0})]},
    {'match': 'Smoke flows task COBALT', 'steps': [call({'vendor_name': 'Cobalt Software'}), cat('/workspace/cobalt.csv'), say(
        'The statement shows 7800.00 invoiced and a credit note of 3900.00: we owe 3900.00 USD.', {'total': 3900.0})]},
    {'match': 'Smoke flows task LATE-FEES', 'steps': [cat('/workspace/policy_terms.json'), say(
        'The rate is 1.5% a month, so the fee on 1000.00 is 15.00.', {'fee': 15.0})]},
]
scripts = list(flows)
for phase in ('phase4', 'phase3', 'phase2'):
    with open(os.path.join(repo, 'scripts', phase + '-mock-scripts.json'), encoding='utf-8') as f:
        scripts += json.load(f)
with open(os.path.join(out, 'mock-scripts.json'), 'w', encoding='utf-8') as f:
    json.dump(scripts, f)

with open(os.path.join(out, 'names.txt'), 'w', encoding='utf-8') as f:
    f.write('\n'.join([
        'suite            ' + suite,
        'skill zip        ' + os.path.join(out, skill + '.zip'),
        'configurations   {0}-baseline, {0}-with-skill, {0}-with-mcp'.format(prefix),
        '                 model mock/scripted · provider custom · base URL http://mock-model:8090/v1',
        'MCP server       {} · stdio · command invoice-db-mcp · env INVOICE_DB_URL'.format(server),
        'its tool         ' + tool,
        'experiments      {0}-skill-vs-baseline, {0}-mcp-vs-baseline'.format(prefix),
        '',
        'start the mock   MOCK_SCRIPTS="$(cat {})" docker compose --profile test up -d'.format(os.path.join(out, 'mock-scripts.json')),
        'load the suite   Suites > Reload all from disk',
        '']))
PY

cat "$OUT/names.txt"
