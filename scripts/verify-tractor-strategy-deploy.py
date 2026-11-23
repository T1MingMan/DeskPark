"""Byte-exact post-deploy verification for the Tractor strategy release (both routes)."""
from pathlib import Path
import hashlib
import json
import re
import urllib.request
import os

REPO = Path(__file__).resolve().parents[1]
VERSION = os.environ.get('TRACTOR_STRATEGY_VERSION', 'v1')
assert VERSION in ('v1', 'v2')
OUT = REPO / ('apps/web/tractor-evidence/strategy/' + VERSION)
ROOT = Path.home() / '.local/share/deskpark'
BASE = os.environ.get('DESKPARK_URL', 'http://127.0.0.1:8787').rstrip('/')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def http(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return response.read()


def main():
    production_before = {}
    before = json.loads((OUT / 'protection-before.json').read_text())
    # Client/UI sources must be byte-identical; only shared engine, scripts and tests changed.
    ui_roots = ['apps/web/src', 'apps/web/legacy', 'apps/web/legacy-tractor', 'apps/web/classic']
    ui = {}
    for root in ui_roots:
        for p in sorted((REPO / root).rglob('*')):
            if p.is_file():
                ui[str(p.relative_to(REPO))] = digest(p.read_bytes())
    if VERSION == 'v1':
        drift = [p for p, h in ui.items() if before.get(p) != h]
    else:
        ui = {p: digest(Path(p).read_bytes()) for p in before}
        drift = [p for p, h in ui.items() if before[p] != h]
        production_before = json.loads((OUT / 'production-protection-before.json').read_text())
        production_drift = [p for p, h in production_before.items() if not Path(p).is_file() or digest(Path(p).read_bytes()) != h]
        assert not production_drift, f'existing production asset changed: {production_drift}'
    assert not drift, f'protected client source bytes changed: {drift}'

    modern = {}
    for p in sorted((REPO / 'apps/web/dist').rglob('*')):
        if p.is_file():
            rel = str(p.relative_to(REPO / 'apps/web/dist'))
            data = p.read_bytes()
            assert (ROOT / 'web' / rel).read_bytes() == data, rel
            assert http('/' + rel) == data, rel
            modern[rel] = digest(data)
    index = http('/')
    assert index == (REPO / 'apps/web/dist/index.html').read_bytes()
    assert index == (ROOT / 'web/index.html').read_bytes()
    assert (ROOT / 'main.mjs').read_bytes() == (REPO / 'apps/server/dist/main.js').read_bytes()

    # Old route: only index-referenced assets are asserted (unreferenced leftovers stay harmless).
    old_html = http('/legacy-tractor/')
    assert old_html == (REPO / 'apps/web/dist-legacy-tractor/index.html').read_bytes()
    refs = [
        r
        for r in re.findall(r'(?:src|href)="([^"]+)"', old_html.decode())
        if r.startswith('/legacy-tractor/') and '?' not in r
    ]
    old = {}
    for r in refs:
        data = http(r)
        assert data == (REPO / 'apps/web/dist-legacy-tractor' / r.split('/')[-1]).read_bytes(), r
        old[r] = digest(data)
    health = json.loads(http('/healthz'))
    assert health['ok'] and health['rooms'] == 0 and health['clients'] == 0, health
    record = {
        'version': VERSION,
        'protectedExistingProductionAssets': len(production_before) if VERSION == 'v2' else None,
        'base': BASE,
        'modernUrl': BASE + '/#/play/tractor',
        'legacyUrl': BASE + '/legacy-tractor/',
        'modernHttpExactFiles': len(modern),
        'modernManifest': modern,
        'legacyIndexReferencedFiles': len(old),
        'legacyManifest': old,
        'clientSourceFilesUnchanged': len(ui),
        'clientSourceDrift': drift,
        'serverExactBuildBytes': True,
        'health': health,
        'rollbackModern': str(
            sorted((Path.home() / '.local/share/deskpark-backups').glob('tractor-*'))[-1]
        ),
        'rollbackLegacy': str(
            sorted((Path.home() / '.local/share/deskpark-rollbacks').glob('legacy-tractor-*'))[-1]
        ),
        'realIOS12DeviceTested': False,
    }
    (OUT / 'deployment-verification.json').write_text(json.dumps(record, indent=2))
    print(
        json.dumps(
            {k: v for k, v in record.items() if 'Manifest' not in k}, ensure_ascii=False, indent=2
        )
    )


if __name__ == '__main__':
    main()
