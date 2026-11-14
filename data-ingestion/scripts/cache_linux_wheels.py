"""Optional Linux ARM64 build cache, verified against official PyPI SHA-256 hashes.

This is a download accelerator for the tested Apple Silicon Docker platform;
normal Docker builds work with an empty _wheels directory on either architecture.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import json
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '_wheels'
CACHE.mkdir(exist_ok=True)
pins = [line.strip().split('==') for line in (ROOT/'requirements.txt').read_text().splitlines() if '==' in line]
pins.append(['torch','2.6.0'])

def fetch(pin):
    package, version = pin
    with urllib.request.urlopen(f'https://pypi.org/pypi/{package}/{version}/json', timeout=30) as r:
        info=json.load(r)
    choices=[]
    for item in info['urls']:
        f=item['filename']
        if not f.endswith('.whl'): continue
        py,abi,platform=f[:-4].rsplit('-',3)[1:]
        compatible = (platform=='any' and ('py3' in py or 'cp312' in py)) or ('aarch64' in platform and ('cp312' in py or abi=='abi3'))
        if compatible:
            choices.append(item)
    if not choices:
        print('No primary wheel cached for',package,flush=True);return
    item=sorted(choices,key=lambda x: ('cp312' not in x['filename'],x['filename']))[0]
    target=CACHE/item['filename']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==item['digests']['sha256']:
        return
    size=item['size']
    if size > 30_000_000:
        # Range transfers are assembled only after all parts complete.
        step=(size+7)//8
        def part(i):
            start=i*step;end=min(size-1,(i+1)*step-1)
            request=urllib.request.Request(item['url'],headers={'Range':f'bytes={start}-{end}'})
            with urllib.request.urlopen(request,timeout=120) as response:
                if response.status!=206: raise ValueError('Server did not honor byte range')
                data=response.read()
            if len(data)!=end-start+1: raise ValueError('Incomplete range')
            return data
        with ThreadPoolExecutor(max_workers=8) as pool:
            data=b''.join(pool.map(part,range(8)))
    else:
        with urllib.request.urlopen(item['url'],timeout=120) as response:
            data=response.read()
    if hashlib.sha256(data).hexdigest()!=item['digests']['sha256']:
        raise ValueError('Hash mismatch: '+item['filename'])
    target.write_bytes(data)
    print('Cached',item['filename'],flush=True)

with ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(fetch,pins))
