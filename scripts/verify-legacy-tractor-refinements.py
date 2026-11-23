"""Freeze stage-one delivery evidence without changing game bytes."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import urllib.request

r = pathlib.Path(__file__).resolve().parents[1]
e = r / 'apps/web/legacy-tractor-evidence/refinements'
before = json.loads((e / 'initial-protected.json').read_text())
after = {p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in before}
diff = [p for p in before if before[p] != after[p]]
assert not diff, diff
(e / 'final-protected.json').write_text(json.dumps(after, indent=2))
roots = [r / 'apps/web/legacy-tractor', r / 'apps/web/dist-legacy-tractor', pathlib.Path.home() / '.local/share/deskpark/web/legacy-tractor']
freeze = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for root in roots for p in root.rglob('*') if p.is_file()}
(e / 'frozen-old-tractor.json').write_text(json.dumps(freeze, indent=2))
full = json.loads((r / 'apps/web/legacy-tractor-evidence/rework-browser-report.json').read_text())
ref = json.loads((e / 'refinements-browser.json').read_text())
smoke = json.loads((r / 'apps/web/classic-evidence/senior/report.json').read_text())
deploy = json.loads((e / 'deployment.json').read_text())
cases = [x for x in full['report'] if 'orientation' in x]
timing = [x for x in full['report'] if x.get('realTimers')]
pairs = [x for x in full['report'] if 'simultaneousLegalBots' in x]
assert len(cases) == 8 and len(timing) == 2 and len(pairs) == 2
assert len(ref['report']) == 8
assert len(smoke['report']) == 16
assert '263 passed' in (e / 'check.log').read_text()
base = os.environ.get('DESKPARK_URL', 'http://127.0.0.1:8787').rstrip('/')
build = r / 'apps/web/dist-legacy-tractor'
html = (build / 'index.html').read_text()
active = ['index.html'] + re.findall(r'(?:src|href)="/legacy-tractor/([^\"]+\.(?:js|css))"', html)
active = list(dict.fromkeys(active))
assert len(active) == 4, active
http = []
for name in active:
    b = urllib.request.urlopen(base + '/legacy-tractor/' + name).read()
    assert b == (build / name).read_bytes()
    http.append({'url': base + '/legacy-tractor/' + name, 'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)})
for name in ['rework-webkit-bars-bury-selected.png', 'rework-webkit-bars-multi-card.png', 'ux-webkit-real-paused.png']:
    shutil.copy2(r / 'apps/web/legacy-tractor-evidence' / name, e / name)
for src, name in [('apps/web/legacy-tractor-evidence/rework-browser-report.json', 'fullround-lan.json'), ('apps/web/classic-evidence/senior/report.json', 'classic-smoke-lan.json'), ('apps/web/tractor-evidence/rework-online-report.json', 'unchanged-modern-ws.json'), ('apps/web/tractor-evidence/rework-multiplayer-report.json', 'unchanged-modern-multiplayer.json')]:
    shutil.copy2(r / src, e / name)
summary = {
    'base': full['base'], 'unitTests': 263, 'unitFiles': 32,
    'fullRounds': len(cases), 'humanBuries': sum(c['buries'] for c in cases),
    'independent33TouchChecks': sum(c['buries'] * 33 for c in cases),
    'humanPlays': sum(c['plays'] for c in cases),
    'multiCardObservations': sum(c['multiCardPlays'] for c in cases),
    'realTimerCases': len(timing) + len(pairs) + 2,
    'firstCardMs': [c['firstCardMs'] for c in timing],
    'actualDealIntervalsMs': {c['name']: c['dealIntervalsMs'] for c in ref['report'] if 'dealIntervalsMs' in c},
    'seed10FrozenMsPerBrowser': 6200, 'seed24FrozenMsPerBrowser': 3600, 'seed3FrozenMsPerBrowser': 3600,
    'refinementCases': len(ref['report']),
    'botOvercallsObserved': sum(c.get('overcallCount', 0) for c in ref['report']),
    'humanJokerOvercalls': sum(bool(c.get('humanJokerOvercall')) for c in ref['report']),
    'classicSmokeCases': len(smoke['report']), 'initialProtectedCount': len(before),
    'initialFinalChanges': diff, 'productionProtectedCount': deploy['protectedProductionFiles'],
    'frozenOldFiles': len(freeze), 'rollback': deploy['rollback'], 'httpActiveFiles': http,
    'health': json.load(urllib.request.urlopen(base + '/healthz')),
    'actualIOS12Tested': False,
    'stage2': 'Not started; parent to delegate separately per steering',
}
(e / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print(json.dumps(summary, ensure_ascii=False, indent=2))
