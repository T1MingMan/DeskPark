"""Publish only the old-iPad lobby; never rebuild games or restart the server."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request


def default_url():
    if os.environ.get('DESKPARK_URL'):
        return os.environ['DESKPARK_URL'].rstrip('/')
    try:
        ip = subprocess.check_output(['ipconfig', 'getifaddr', 'en0'], text=True).strip()
        if ip:
            return f'http://{ip}:8787'
    except Exception:
        pass
    return 'http://127.0.0.1:8787'


REPO = Path(__file__).resolve().parents[1]
ROOT = Path.home() / '.local/share/deskpark/web'
SOURCE = REPO / 'apps/web/classic'
BASE = default_url()


def manifest(root, exclude_classic=False):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()
            and not (exclude_classic and p.relative_to(root).parts[0] == 'classic')}


def fetch(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return response.read()


def main():
    before = manifest(ROOT, exclude_classic=True)
    protected = {str(p): manifest(p) for p in
                 [REPO / 'apps/web/legacy', REPO / 'apps/web/legacy-tractor']}
    modern = fetch('/')
    server = hashlib.sha256((ROOT.parent / 'main.mjs').read_bytes()).hexdigest()
    target = ROOT / 'classic'
    backup = Path.home() / '.local/share/deskpark-backups' / (
        'classic-home-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    existed = target.exists()
    if existed:
        shutil.copytree(target, backup / 'classic')
    record = {'backup': str(backup), 'previousClassicExists': existed,
              'protectedProduction': before, 'protectedSources': protected}
    (backup / 'preservation.json').write_text(json.dumps(record, indent=2))
    print('ROLLBACK:', backup, flush=True)
    target.mkdir(exist_ok=True)
    try:
        # Single self-contained file: atomic replacement, no dependency ordering.
        shutil.copy2(SOURCE / 'index.html', target / 'index.html.next')
        os.replace(target / 'index.html.next', target / 'index.html')
        assert fetch('/classic/') == (SOURCE / 'index.html').read_bytes()
        assert fetch('/') == modern
        assert manifest(ROOT, exclude_classic=True) == before
        assert all(manifest(Path(p)) == expected for p, expected in protected.items())
        assert hashlib.sha256((ROOT.parent / 'main.mjs').read_bytes()).hexdigest() == server
        # Read back every existing old-game asset from the actual LAN service.
        old_count = 0
        for rel, expected in before.items():
            if rel.startswith(('legacy/', 'legacy-tractor/')):
                assert hashlib.sha256(fetch('/' + rel)).hexdigest() == expected, rel
                old_count += 1
        health = json.loads(fetch('/healthz'))
        assert health['ok']
        record.update(health=health, preservedProductionFiles=len(before),
                      legacyHTTPFiles=old_count, modernHTTPUnchanged=True,
                      serverUnchanged=True, classicHTTPMatches=True)
        (backup / 'preservation.json').write_text(json.dumps(record, indent=2))
        print(json.dumps({k: v for k, v in record.items()
                          if k not in ('protectedProduction', 'protectedSources')}, indent=2))
    except Exception:
        if existed:
            shutil.copy2(backup / 'classic/index.html', target / 'index.html')
        else:
            shutil.rmtree(target)
        raise


if __name__ == '__main__':
    main()
