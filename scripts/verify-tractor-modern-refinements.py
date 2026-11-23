"""Read back every modern build file and protected old route after modern delivery."""
from pathlib import Path
import hashlib
import json
import os
import urllib.request

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / 'apps/web/tractor-evidence/refinements-modern'
ROOT = Path.home() / '.local/share/deskpark'
BASE = os.environ.get('DESKPARK_URL', 'http://127.0.0.1:8787').rstrip('/')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def http(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return response.read()

def main():
    frozen = json.loads((REPO / 'apps/web/legacy-tractor-evidence/refinements/frozen-old-tractor.json').read_text())
    before = json.loads((OUT / 'protected-before.json').read_text())
    latest = json.loads((OUT / 'protected-predeploy.json').read_text())
    for baseline in [frozen, before, latest]:
        assert all(Path(p).is_file() and digest(Path(p).read_bytes()) == h for p, h in baseline.items())
    old_roots = [REPO / 'apps/web/legacy', REPO / 'apps/web/legacy-tractor', REPO / 'apps/web/dist-legacy-tractor', REPO / 'apps/web/classic', ROOT / 'web/legacy', ROOT / 'web/legacy-tractor', ROOT / 'web/classic']
    actual = {str(p.resolve()): digest(p.read_bytes()) for root in old_roots for p in root.rglob('*') if p.is_file()}
    assert actual == latest, 'Complete old roots changed, including additions/removals'
    modern = {}
    for p in sorted((REPO / 'apps/web/dist').rglob('*')):
        if not p.is_file():
            continue
        rel = str(p.relative_to(REPO / 'apps/web/dist'))
        data = p.read_bytes()
        assert (ROOT / 'web' / rel).read_bytes() == data
        assert http('/' + rel) == data, rel
        modern[rel] = digest(data)
    assert http('/') == (REPO / 'apps/web/dist/index.html').read_bytes()
    old_http = {}
    for p, h in latest.items():
        path = Path(p)
        if path.is_relative_to(ROOT / 'web'):
            rel = str(path.relative_to(ROOT / 'web'))
            assert digest(http('/' + rel)) == h, rel
            old_http[rel] = h
    assert (ROOT / 'main.mjs').read_bytes() == (REPO / 'apps/server/dist/main.js').read_bytes()
    health = json.loads(http('/healthz'))
    assert health['ok']
    record = {
        'base': BASE, 'modernUrl': BASE + '/#/play/tractor',
        'modernHttpExactFiles': len(modern), 'modernManifest': modern,
        'oldHttpExactFiles': len(old_http), 'oldHttpManifest': old_http,
        'frozenOldTractorFilesUnchanged': len(frozen),
        'protectedInitialFilesUnchanged': len(before),
        'completeLatestOldRootsFilesUnchanged': len(latest),
        'concurrentProtectedDrift': [], 'serverExactBuildBytes': True,
        'health': health,
        'rollback': str(Path.home() / '.local/share/deskpark-backups/tractor-20261106-020636'),
        'realIOS12DeviceTested': False,
    }
    (OUT / 'verification.json').write_text(json.dumps(record, indent=2))
    print(json.dumps({k:v for k,v in record.items() if 'Manifest' not in k}, indent=2))

if __name__ == '__main__':
    main()
