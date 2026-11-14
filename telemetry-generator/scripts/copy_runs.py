#!/usr/bin/env python3
"""Copy generated public runs into a mission's telemetry folder, checking each file against its manifest.

Only the three agent-visible files of each run are copied (run_manifest.json, telemetry.csv, events.jsonl).
Nothing from evaluator_only/ is ever read or copied.

  python3 telemetry-generator/scripts/copy_runs.py --to data-ingestion/missions/brahmastra/telemetry
  python3 telemetry-generator/scripts/copy_runs.py --to data-ingestion/missions/brahmastra/telemetry --run BM-RUN-0010 --force
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = ('run_manifest.json', 'telemetry.csv', 'events.jsonl')


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--to', required=True, type=Path, help="the mission's telemetry folder, e.g. data-ingestion/missions/brahmastra/telemetry")
    ap.add_argument('--from', dest='source', type=Path, default=ROOT / 'agent_visible' / 'runs', help='generated runs (default: agent_visible/runs)')
    ap.add_argument('--run', action='append', help='copy only this run (repeatable)')
    ap.add_argument('--force', action='store_true', help='overwrite runs that already exist in the target')
    args = ap.parse_args()

    if any(part in ('evaluator_only', 'ground_truth') for part in args.source.resolve().parts):
        print('Refusing to copy from an evaluator-only location.', file=sys.stderr)
        return 2
    runs = sorted(p for p in args.source.glob('BM-RUN-*') if p.is_dir())
    if args.run:
        runs = [p for p in runs if p.name in set(args.run)]
    if not runs:
        print(f'No runs found in {args.source}. Run generator/generate.py first.', file=sys.stderr)
        return 1
    args.to.mkdir(parents=True, exist_ok=True)
    copied = skipped = 0
    for run in runs:
        manifest = json.loads((run / 'run_manifest.json').read_text())
        for name, key in (('telemetry.csv', 'telemetry_sha256'), ('events.jsonl', 'events_sha256')):
            if sha256(run / name) != manifest[key]:
                print(f'{run.name}/{name} does not match its manifest hash; regenerate before copying.', file=sys.stderr)
                return 1
        dest = args.to / run.name
        if dest.exists() and not args.force:
            skipped += 1
            continue
        dest.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            shutil.copy2(run / name, dest / name)
        copied += 1
    print(f'Copied {copied} run(s) to {args.to}; {skipped} already present (use --force to overwrite).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
