"""Development helper: load this folder's simple .env and run ingestion locally."""
from pathlib import Path
import os
import runpy
import sys

root = Path(__file__).resolve().parents[1]
os.chdir(root)
sys.path.insert(0, str(root))
for line in (root / '.env').read_text().splitlines():
    if line.strip() and not line.lstrip().startswith('#'):
        key, value = line.split('=', 1)
        os.environ.setdefault(key, value)
runpy.run_module('ingestion', run_name='__main__')
