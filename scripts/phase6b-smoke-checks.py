"""The checks' helpers for scripts/phase6b-smoke.sh, which runs each check as one
Python expression over `d` (the JSON of the last response or of a file) with
these names in scope. It sets REPO_DIR, SUITES_DIR, PREFIX, the TASKS_*
lists and, per check, WANT and the like in the environment.

str.format, not f-strings, and nothing past Python 3.8, as the smoke runs
on the host's python3.
"""
import functools, json, os, re

env = os.environ
REPO = env['REPO_DIR']


def tasks(name):
    return env['TASKS_' + name].split(',')


@functools.lru_cache(None)
def scripts(suite):
    """A Phase 6b suite's mock scripts, in file order."""
    path = os.path.join(REPO, 'scripts', 'phase6b-{}-mock-scripts.json'.format(suite))
    with open(path, encoding='utf-8') as f:
        return json.load(f)


@functools.lru_cache(None)
def prompt(suite, task):
    with open(os.path.join(env['SUITES_DIR'], suite, task, 'prompt.md'), encoding='utf-8') as f:
        return f.read()


def cfg(arm):
    """A configuration's full name: smoke-<stamp>-<suite>-<arm>."""
    return env['PREFIX'] + '-' + arm


def want():
    return json.loads(env['WANT'])


# --- Run lists, run details, comparisons -------------------------------------

def sc(run, key):
    return next(s for s in run['scores'] if s['key'] == key)


def primary(runs, task, arm):
    """The primary status of a task's runs under a configuration, every repetition alike, or the statuses joined by '/'."""
    got = sorted({(r['primaryScore'] or {}).get('status') or 'none' for r in runs['rows']
                  if r['taskKey'] == task and r['configuration']['name'] == cfg(arm)})
    return '/'.join(got) or 'missing'


def primaries_ok(runs, pred):
    return all(primary(runs, t, a) == w for a, row in pred.items() for t, w in row.items())


def primaries_line(runs, pred):
    """Per arm: how many tasks passed, and the tasks whose status is not the predicted one."""
    out = []
    for a, row in pred.items():
        passed = sum(primary(runs, t, a) == 'passed' for t in row)
        off = ['{}:{}'.format(t, primary(runs, t, a)) for t, w in row.items() if primary(runs, t, a) != w]
        out.append('{} {}/{} passed{}'.format(a, passed, len(row), ' (not as predicted: {})'.format(', '.join(off)) if off else ''))
    return ' · '.join(out)


def comparison_ok(view, w):
    s = view['statistics']
    return (s is not None and s['verdict'] == w['verdict'] and round(s['observedDelta'], 3) == w['delta']
            and s['lo'] > 0 and (w.get('lo') is None or round(s['lo'], 3) == w['lo'])
            and not view['provisional'] and view['repetitions'] == 2
            and [view['filterCounts'][k] for k in ('improved', 'regressed', 'unchanged')] == w['changes']
            and [[view['passCounts'][a]['passed'], view['passCounts'][a]['counted']] for a in ('baseline', 'candidate')] == w['passes'])


def comparison_line(view):
    s = view['statistics'] or {}
    return 'Δ {:+.3f} [{:+.3f}, {:+.3f}] {} · {}/{} -> {}/{} · improved {improved}, regressed {regressed}, unchanged {unchanged}'.format(
        s.get('observedDelta', 0), s.get('lo', 0), s.get('hi', 0), s.get('verdict'),
        view['passCounts']['baseline']['passed'], view['passCounts']['baseline']['counted'],
        view['passCounts']['candidate']['passed'], view['passCounts']['candidate']['counted'], **view['filterCounts'])


def runs_of(d, arm, task=None):
    """The run details of one configuration (and task) in a details list."""
    return [r for r in d if r['configuration']['name'] == cfg(arm) and (task is None or r['task']['key'] == task)]


def events(run, kind='tool'):
    return [e for e in run['timeline']['events'] if e['kind'] == kind]


def outputs(run, title=None):
    return [e['output'] or '' for e in events(run) if title is None or e['title'] == title]


def argv(run):
    return run['launchRecord']['command'].split()


def toolsets(run):
    a = argv(run)
    return a[a.index('-t') + 1] if '-t' in a else ''


def preloaded(run):
    a = argv(run)
    return sorted(a[i + 1] for i, x in enumerate(a[:-1]) if x == '-s')


def artifact(run, path):
    return next((x for x in run['artifacts']['items'] if x['path'] == path), None)


def mcp_events(run):
    return [e for e in events(run) if e['server']]


# --- The mock's request log, summarised by mock_summary ----------------------

def finals(d, find):
    """{task: {script: count}} over the requests that got a final answer, the task found from the prompt."""
    out = {}
    for x in d:
        task = find(x['user'])
        if task is None or not x['final']:
            continue
        row = out.setdefault(task, {})
        row[x['script']] = row.get(x['script'], 0) + 1
    return out


def by_tag(pattern, keys, fix=lambda m: m):
    def find(user):
        m = re.search(pattern, user)
        return fix(m.group(1)) if m and fix(m.group(1)) in keys else None
    return find


find_mcp = by_tag(r'Ticket mcpv1-([a-z-]+)\.', tasks('MCP'), lambda m: m.replace('-', '_'))
find_tools = by_tag(r'Request tv1-([a-z_]+)\.', tasks('TOOLS'))
find_memory = by_tag(r'Ticket mv1-t(\d\d)\.', tasks('MEMORY'), lambda m: tasks('MEMORY')[int(m) - 1] if 0 < int(m) <= 8 else m)


@functools.lru_cache(None)
def knowledge_phrases():
    """Each knowledge-v1 task's prompt phrase: the script that plays the run with no knowledge."""
    s = scripts('knowledge-v1')
    out = {}
    for t in tasks('KNOWLEDGE'):
        text = prompt('knowledge-v1', t)
        out[t] = next(x['match'] for x in s if x['match'] in text and 'tool' in x['steps'][0])
    return out


def find_knowledge(user):
    return next((t for t, p in knowledge_phrases().items() if p in user), None)


KNOWLEDGE_FINALS = {
    'closing_balance': 'file statement_2026_03.bx7: format BX07,',
    'record_counts': 'file statement_2026_04.bx7: format BX07,',
    'large_file': 'file statement_2026_q2.bx7: format BX07,',
    'reason_codes': 'kv1-bx7-codes',
    'pick_version': 'file treasury_export.bx: format BX07,',
    'house_summary': 'kv1-summary-template',
    'prompt_override': 'file ledger_view_2026_07.bx7: format BX07,',
}


def expected_finals(suite):
    """{task: {script: count}}: the script each run's last request picks, 2 repetitions."""
    s = scripts(suite)
    if suite == 'mcp-v1':
        # The task's MCP script in with-mcp; the documents script (the ledger's header) in docs-export.
        return {t: {s[i]['match']: 2, s[len(tasks('MCP'))]['match']: 2} for i, t in enumerate(tasks('MCP'))}
    if suite == 'memory-v1':
        return {t: {'ref mv1-s{:02d}'.format(i + 1): 2, 'Ticket mv1-t{:02d}'.format(i + 1): 2}
                for i, t in enumerate(tasks('MEMORY'))}
    if suite == 'tools-v1':
        out = {}
        for t in tasks('TOOLS'):
            if t == 'small_lookup':
                row = next(x['match'] for x in s if x['match'].startswith('PX-'))
                out[t] = {row: 6}
            else:
                out[t] = {outcome(t, 'code'): 2, outcome(t, 'term'): 2, 'tv1-{}.'.format(t): 2}
        return out
    phrases = knowledge_phrases()
    return {t: ({phrases[t]: 8} if t not in KNOWLEDGE_FINALS else {KNOWLEDGE_FINALS[t]: 6, phrases[t]: 2})
            for t in tasks('KNOWLEDGE')}


@functools.lru_cache(None)
def outcome(task, kind):
    """tools-v1's outcome phrase: what the task's execute_code (code) or terminal (term) call prints."""
    return next(x['match'] for x in scripts('tools-v1') if x['match'].startswith('tv1-{}-{}='.format(task, kind)))


@functools.lru_cache(None)
def seed_entries(task):
    out = []
    for name in ('MEMORY.md', 'USER.md'):
        with open(os.path.join(env['SUITES_DIR'], 'memory-v1', task, 'home', 'memories', name), encoding='utf-8') as f:
            text = f.read().replace('\r\n', '\n')
        out += [e.strip() for e in text.split('\n§\n') if e.strip()]
    return out


def seeds_ok(d):
    """Memory on (seed script): every seed entry in the system prompt, none blocked. Memory off: no seed marker."""
    seen = 0
    for x in d:
        task = find_memory(x['user'])
        if task is None:
            continue
        n = '{:02d}'.format(tasks('MEMORY').index(task) + 1)
        system = x['system'] or ''
        if x['script'] == 'ref mv1-s' + n:
            if not all(e in system for e in seed_entries(task)) or '[BLOCKED:' in system:
                return False
            seen += 1
        elif x['script'] == 'Ticket mv1-t' + n:
            if 'ref mv1-s' in system:
                return False
        else:
            return False
    return seen > 0
