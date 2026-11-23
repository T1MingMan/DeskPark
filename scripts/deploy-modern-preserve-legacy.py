"""Deploy only modern artifacts; preserve legacy bytes and retain rollback."""
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
ROOT = Path.home() / '.local/share/deskpark'
URL = default_url()
LABEL = os.environ.get('DESKPARK_LABEL', f'cn.{os.environ.get("USER", "local")}.deskpark')

def manifest(path):
    return {str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(path.rglob('*')) if p.is_file()}

def health():
    with urllib.request.urlopen(URL + '/healthz', timeout=5) as r:
        return json.load(r)

def main():
    h = health()
    if h['rooms'] or h['clients']:
        raise SystemExit('Active rooms/clients: refusing restart: ' + str(h))
    backup = Path.home() / '.local/share/deskpark-backups' / ('tractor-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT, backup)
    legacy = manifest(ROOT / 'web/legacy')
    source = manifest(REPO / 'apps/web/legacy')
    protected = {str(p): manifest(p) for p in [ROOT / 'web/legacy', ROOT / 'web/legacy-tractor', REPO / 'apps/web/legacy', REPO / 'apps/web/legacy-tractor']}
    assert all(protected.values()), 'Both legacy clients must be present'
    assert legacy, 'Legacy directory must exist'
    record = {'backup': str(backup), 'legacy': legacy, 'sourceLegacy': source}
    (backup / 'tractor-preservation.json').write_text(json.dumps(record, indent=2))
    print('ROLLBACK:', backup, flush=True)
    assert not (REPO / 'apps/web/dist/legacy').exists()
    assert not (REPO / 'apps/web/dist/legacy-tractor').exists()
    # Keep old hashed assets available to already-open modern browser tabs.
    for p in (REPO / 'apps/web/dist').rglob('*'):
        if p.is_file() and p.name != 'index.html':
            target = ROOT / 'web' / p.relative_to(REPO / 'apps/web/dist')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, target)
    shutil.copy2(REPO / 'apps/web/dist/index.html', ROOT / 'web/index.html.next')
    os.replace(ROOT / 'web/index.html.next', ROOT / 'web/index.html')
    shutil.copy2(REPO / 'apps/server/dist/main.js', ROOT / 'main.mjs.next')
    os.replace(ROOT / 'main.mjs.next', ROOT / 'main.mjs')
    assert manifest(ROOT / 'web/legacy') == legacy
    assert manifest(REPO / 'apps/web/legacy') == source
    h = health()
    if h['rooms'] or h['clients']:
        raise SystemExit('Clients appeared; artifacts copied but restart deferred: ' + str(h))
    subprocess.run(['launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/{LABEL}'], check=True)
    for _ in range(30):
        time.sleep(1)
        try:
            if health()['ok']:
                break
        except Exception:
            pass
    else:
        raise RuntimeError('Service failed to recover; restore rollback')
    assert manifest(ROOT / 'web/legacy') == legacy
    assert manifest(REPO / 'apps/web/legacy') == source
    for rel, expected in legacy.items():
        with urllib.request.urlopen(URL + '/legacy/' + rel, timeout=5) as r:
            assert hashlib.sha256(r.read()).hexdigest() == expected, rel
    assert (ROOT / 'main.mjs').read_bytes() == (REPO / 'apps/server/dist/main.js').read_bytes()
    assert all(manifest(Path(p)) == value for p, value in protected.items())
    for rel, expected in protected[str(ROOT / 'web/legacy-tractor')].items():
        with urllib.request.urlopen(URL + '/legacy-tractor/' + rel, timeout=5) as r:
            assert hashlib.sha256(r.read()).hexdigest() == expected, rel
    assert (ROOT / 'web/index.html').read_bytes() == (REPO / 'apps/web/dist/index.html').read_bytes()
    record.update(health=health(), legacyVerifiedFiles=len(legacy), sourceLegacyVerifiedFiles=len(source))
    (backup / 'tractor-preservation.json').write_text(json.dumps(record, indent=2))
    print(json.dumps({k:v for k,v in record.items() if k not in ('legacy','sourceLegacy')}, indent=2))

if __name__ == '__main__':
    main()
