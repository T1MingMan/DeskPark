"""Rollback-backed publication of both old clients and their lobby only."""
import hashlib
import json
import os
from pathlib import Path
import re
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
BASE = default_url()
ROUTES = ('legacy', 'legacy-tractor', 'classic')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def protected():
    return {str(p.relative_to(ROOT.parent)): digest(p.read_bytes())
            for p in sorted(ROOT.parent.rglob('*')) if p.is_file()
            and not (p.is_relative_to(ROOT) and p.relative_to(ROOT).parts[0] in ROUTES)}


def fetch(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as response:
        assert response.status == 200
        return response.read()


def main():
    before = protected()
    modern = fetch('/')
    backup = Path.home() / '.local/share/deskpark-backups' / ('classic-senior-' + time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True, exist_ok=False)
    for route in ROUTES:
        shutil.copytree(ROOT / route, backup / route)
    report = {'base': BASE, 'rollback': str(backup), 'protectedBefore': before, 'published': []}
    (backup / 'preservation.json').write_text(json.dumps(report, indent=2))
    print('ROLLBACK:', backup, flush=True)
    try:
        for route in ROUTES:
            source = REPO / ('apps/web/classic' if route == 'classic' else 'apps/web/dist-' + route)
            html = (source / 'index.html').read_text()
            assets = re.findall(r'(?:src|href)="/' + re.escape(route) + r'/([^"?#]+\.(?:js|css))"', html)
            names = list(dict.fromkeys(assets)) + ['index.html']
            for name in names:
                target = ROOT / route / name
                shutil.copy2(source / name, str(target) + '.next')
                os.replace(str(target) + '.next', target)
                data = fetch('/' + route + '/' + name)
                assert data == (source / name).read_bytes(), name
                report['published'].append({'url': '/' + route + '/' + name, 'sha256': digest(data), 'bytes': len(data), 'status': 200})
                print('HTTP exact readback:', report['published'][-1], flush=True)
            assert fetch('/' + route + '/') == (source / 'index.html').read_bytes()
        assert protected() == before, 'modern/server/supporting files changed'
        assert fetch('/') == modern
        modern_http = []
        for rel, expected in before.items():
            if rel.startswith('web/'):
                assert digest(fetch('/' + rel[4:])) == expected, rel
                modern_http.append(rel)
        report.update(protectedCount=len(before), modernHTTPFiles=modern_http,
                      modernHTTPUnchanged=True, health=json.loads(fetch('/healthz')))
        assert report['health']['ok']
        out = REPO / 'apps/web/classic-evidence/senior/deployment.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2))
        (backup / 'preservation.json').write_text(json.dumps(report, indent=2))
        print('PASS:', json.dumps({k: v for k, v in report.items() if k not in ('protectedBefore', 'published', 'modernHTTPFiles')}, ensure_ascii=False))
    except Exception:
        for route in ROUTES:
            shutil.rmtree(ROOT / route)
            shutil.copytree(backup / route, ROOT / route)
        raise


if __name__ == '__main__':
    main()
