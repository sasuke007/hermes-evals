"""The helpers of scripts/phase5b-smoke.sh: the Flow E suite it writes through
the draft API (request bodies, `python3 phase5b-smoke-checks.py body <name>`),
folder snapshots, zips (a suite's copy, and the ones the hardened reader must
refuse), and the names each check expression has in scope (`d` is the JSON of
the last response or of a file). The script sets REPO_DIR, SUITES_DIR, WORK,
FOLDER and, per check, the values it compares in the environment.

str.format, not f-strings, and nothing past Python 3.8, as the smoke runs on
the host's python3.
"""
import hashlib, json, os, stat, sys, zipfile

env = os.environ
ANSWER_LEAD = 'End your reply with your answer as a fenced JSON block, exactly in this shape:'


def answer_paragraph(shape):
    """The paragraph "Add answer instructions" appends (packages/shared authoring.ts)."""
    return '{}\n\n```json\n{}\n```'.format(ANSWER_LEAD, shape)


# The two Flow E tasks, as the task editor fills them in (the mock scripts of
# scripts/phase5b-mock-scripts.json answer them by the first line of each prompt).
UNPAID_PROMPT = ('Flow E smoke: add up the `amount` column of `invoices.csv` for the rows whose '
                 '`status` is `unpaid`.\n\n' + answer_paragraph('{ "unpaid_total": 0.0 }') + '\n')
VENDOR_PROMPT = ('Flow E smoke: read `ledger.csv` and write `summary.csv` with the columns '
                 'vendor,total, one row per vendor.\n\n' + answer_paragraph('{ "done": false }') + '\n')
FILES = {
    'invoices.csv': 'id,status,amount\n1,paid,120.00\n2,unpaid,80.25\n3,unpaid,19.25\n4,paid,40.00\n',
    'ledger.csv': 'vendor,amount\nAcme,10\nAcme,5\nGlobex,7\n',
    'summary.csv': 'vendor,total\nAcme,15\nGlobex,7\n',
    'questions.csv': ('key,question,answer\n'
                      'paid_total,"Flow E smoke import: add up the `amount` column of `invoices.csv` '
                      'for the rows whose `status` is `paid`.",160\n'
                      'all_total,"Flow E smoke import: add up the whole `amount` column of `invoices.csv`.",259.5\n'),
    'bad-keys.csv': ('key,question,answer\n'
                     'paid total,"Flow E smoke import: the `paid` rows of `invoices.csv`.",160\n'),
}


def form(**over):
    base = {'summary': '', 'maxTurns': 20, 'runBudgetSeconds': 300, 'toolsetsNeeded': ['file', 'terminal'],
            'answerPath': None, 'checks': [], 'expectedWorkspace': None, 'expectedHome': None,
            'negativeControl': None}
    base.update(over)
    return base


FILE_CHECK = {'key': 'summary_csv', 'type': 'file_check', 'primary': True,
              'params': {'path': 'summary.csv', 'format': 'csv', 'columns': ['vendor', 'total'], 'row_count': 2}}
BODIES = {
    'unpaid': {'form': form(summary='Total of the unpaid invoices', answerPath='unpaid_total',
                            checks=[{'key': 'answer', 'type': 'numeric_tolerance', 'primary': True,
                                     'params': {'abs': 0.01}}]),
               'prompt': UNPAID_PROMPT, 'reference': '{ "unpaid_total": 99.5 }\n'},
    # A new File check before its path is set: readiness asks for it in plain words.
    'vendor-nopath': {'form': form(summary='Write summary.csv with one row per vendor',
                                   checks=[dict(FILE_CHECK, params={'format': 'csv'})]),
                      'prompt': VENDOR_PROMPT, 'reference': '{ "done": true }\n'},
    'vendor': {'form': form(summary='Write summary.csv with one row per vendor', checks=[FILE_CHECK],
                            expectedWorkspace='expected'),
               'prompt': VENDOR_PROMPT, 'reference': '{ "done": true }\n'},
}


def import_settings(keys=True):
    mapping = [{'column': 'key', 'use': 'task_key'}, {'column': 'question', 'use': 'prompt'},
               {'column': 'answer', 'use': 'reference_value'}]
    return {'mapping': mapping, 'keyPrefix': None, 'answerPath': 'total',
            'workspace': {'from': 'task', 'key': 'unpaid_total'}, 'checks': {'from': 'task', 'key': 'unpaid_total'},
            'limits': {'maxTurns': 10, 'runBudgetSeconds': 120, 'toolsetsNeeded': ['file']},
            'appendAnswerInstructions': True, 'keyFixes': []}


# --- Folders and zips ---------------------------------------------------------

def sha(data):
    return hashlib.sha256(data).hexdigest()


def tree(root):
    """Every file under root (dot names included) by relative path, with its sha256."""
    out = {}
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            with open(full, 'rb') as f:
                out[os.path.relpath(full, root)] = sha(f.read())
    return out


def zip_tree(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: sha(z.read(i)) for i in z.infolist() if not i.filename.endswith('/')}


def zip_text(path, name):
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode('utf-8')


def make_zip(src, out, prefix):
    """The folder's files under `prefix/`, as a suite export holds them."""
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(tree(src)):
            z.write(os.path.join(src, rel), prefix + '/' + rel)


def bad_zip(src, out, kind):
    """A valid suite's zip plus one entry the hardened reader refuses (a link, `..`, an absolute path)."""
    make_zip(src, out, 'bad')
    with zipfile.ZipFile(out, 'a') as z:
        if kind == 'link':
            info = zipfile.ZipInfo('bad/smoke_link')
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            z.writestr(info, '../../etc/passwd')
        elif kind == 'dotdot':
            z.writestr('bad/../escape.txt', 'outside the suite\n')
        else:
            z.writestr('/abs/escape.txt', 'absolute\n')


def lines_changed(a, b):
    with open(a, encoding='utf-8') as f:
        x = f.read().split('\n')
    with open(b, encoding='utf-8') as f:
        y = f.read().split('\n')
    return [line for i, line in enumerate(y) if i >= len(x) or x[i] != line]


def jfile(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'body':
        print(json.dumps(BODIES[sys.argv[2]]))
    elif cmd == 'settings':
        print(json.dumps(import_settings()))
    elif cmd == 'file':
        sys.stdout.write(FILES[sys.argv[2]])
    elif cmd == 'zip':
        make_zip(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'bad-zip':
        bad_zip(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == 'tree':
        print(json.dumps(tree(sys.argv[2])))
    else:
        sys.exit('unknown command ' + cmd)
