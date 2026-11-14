import hashlib, json, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT.parent
files=sorted(p for p in ROOT.rglob('*') if p.is_file() and p.name!='SHA256SUMS.txt')
(ROOT/'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(ROOT).as_posix()}\n' for p in files))

def make_zip(dest, selected):
    with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=7) as z:
        for p in selected:z.write(p,arcname=str(p.relative_to(ROOT)))
    with zipfile.ZipFile(dest) as z:
        assert z.testzip() is None
        return len(z.namelist()),sum(x.file_size for x in z.infolist())
full=OUT/'Brahmastra_Telemetry_RC1_FULL.zip'
agent=OUT/'Brahmastra_Telemetry_RC1_AGENT_VISIBLE.zip'
print('full',make_zip(full,sorted(p for p in ROOT.rglob('*') if p.is_file())))
print('agent',make_zip(agent,sorted(p for p in (ROOT/'agent_visible').rglob('*') if p.is_file())))
print('archive sizes',full.stat().st_size,agent.stat().st_size)
print('sha256 full',hashlib.sha256(full.read_bytes()).hexdigest())
