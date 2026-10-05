"""Work plan for the originals workflow (workflows/originals.js), read from disk: for every RW skill,
each batch rw-002..rw-<last> that is not yet promoted, and what it still needs:
write (nothing on disk), complete (a partial file), verify (a full file, no blind
answers yet), or fix (blind answers written, not yet promoted)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import malformed
from common import slug, OUT as EXTRACTED
OUT = EXTRACTED / 'out' / 'original'
LAST = int(sys.argv[1]) if len(sys.argv) > 1 else 11
SKILLS = ['Boundaries', 'Form, Structure, and Sense', 'Cross-Text Connections', 'Text Structure and Purpose', 'Words in Context',
          'Rhetorical Synthesis', 'Transitions', 'Central Ideas and Details', 'Command of Evidence', 'Inferences']
plan = []
for skill in SKILLS:
    steps = []
    for wave in range(2, LAST + 1):
        name = f'rw-{wave:03d}-{slug(skill)}'
        if (OUT / f'{name}.verify-01.jsonl').exists():
            continue
        path = OUT / f'{name}.jsonl'
        blind = OUT / f'{name}.blind-01.jsonl'
        if blind.exists():
            # A verifier stopped mid-write leaves too few lines: solve it again.
            questions = sum(1 for l in path.read_text(encoding='utf8').splitlines() if l.strip())
            answered = sum(1 for l in blind.read_text(encoding='utf8').splitlines() if l.strip())
            if answered >= questions:
                steps.append({'wave': wave, 'state': 'fix'}); continue
            blind.unlink()
        if not path.exists():
            steps.append({'wave': wave, 'state': 'write'}); continue
        good = {'easy': 0, 'medium': 0, 'hard': 0}
        for line in path.read_text(encoding='utf8').splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not malformed(r):
                good[r['difficulty']] += 1
        steps.append({'wave': wave, 'state': 'verify' if all(n >= 10 for n in good.values()) else 'complete', 'have': good})
    plan.append({'skill': skill, 'slug': slug(skill), 'steps': steps})
print(json.dumps(plan))
