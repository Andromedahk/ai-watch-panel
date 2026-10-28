#!/usr/bin/env python3
"""Real UI acceptance against scripts/cloud-device-fixture.cjs, with no production credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.local/qa/cloud-sync/ios-ui'
STEPS = [
    ('pair', 'resetScenario', 'test01PairAndStyles'), ('visual', 'resetScenario', 'test10SharedVisuals'), ('answer', 'input', 'test02Answer'),
    ('approve', 'approval', 'test03Approve'), ('deny', 'deny', 'test04Deny'),
    ('offline', 'offline', 'test05Offline'), ('inbox', 'lowquota', 'test06Inbox'),
    ('live-enable', 'resetScenario', 'test11LivePairEnable'), ('live-update', 'input', 'test12LiveInspect'),
    ('live-open', 'input', 'test14LiveOpenApp'), ('live-clear', 'lowquota', 'test15LiveClear'), ('live-disable', 'resetScenario', 'test13LiveDisable'),
    ('animation', 'approval', 'test09NativeAnimation'), ('push', None, 'test07SimulatedPush'), ('revoke', 'revoke', 'test08Revoked'),
]

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', type=Path, default=ROOT / '.local/qa/cloud-sync/device-fixture/ios.json')
    parser.add_argument('--simulator', help='An existing dedicated QA simulator; never use a personal simulator.')
    parser.add_argument('--steps', default=','.join(s[0] for s in STEPS))
    parser.add_argument('--skip-build', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.fixture.read_text())
    if config.get('synthetic') is not True or not config['url'].startswith('https://localhost:'):
        raise SystemExit('Only the isolated localhost synthetic fixture is accepted.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    qa = OUTPUT / 'qa-config.json'
    qa.write_text(json.dumps({'url': config['url'], 'bootstrapToken': config['bootstrapToken']})); qa.chmod(0o600)
    simulator = args.simulator
    if not simulator:
        runtimes = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'runtimes', '-j']))['runtimes']
        runtime = next(r['identifier'] for r in runtimes if r.get('isAvailable') and r['name'].startswith('iOS'))
        types = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devicetypes', '-j']))['devicetypes']
        device = next(d['identifier'] for d in types if d['name'] == 'iPhone 17 Pro')
        simulator = subprocess.check_output(['xcrun', 'simctl', 'create', 'AIWatch Cloud QA', device, runtime], text=True).strip()
    devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j']))['devices']
    selected = next((device for group in devices.values() for device in group if device['udid'] == simulator), None)
    if not selected or selected.get('name') != 'AIWatch Cloud QA':
        raise SystemExit('Refusing to import the test CA into a non-dedicated simulator; use AIWatch Cloud QA.')
    (OUTPUT / 'simulator-id').write_text(simulator)
    subprocess.run(['xcrun', 'simctl', 'boot', simulator], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(['xcrun', 'simctl', 'bootstatus', simulator, '-b'], stdout=subprocess.DEVNULL)
    run(['xcrun', 'simctl', 'keychain', simulator, 'add-root-cert', config['caFile']], stdout=subprocess.DEVNULL)
    derived = OUTPUT / 'DerivedData'
    base = ['xcodebuild', '-project', str(ROOT / 'mobile/ios/AIWatch.xcodeproj'), '-scheme', 'AIWatchQA',
            '-destination', 'platform=iOS Simulator,id=' + simulator, '-derivedDataPath', str(derived),
            'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'AI_WATCH_QA_CONFIG=' + str(qa)]
    if not args.skip_build:
        with (OUTPUT / 'build.log').open('w') as log:
            run(base + ['build-for-testing'], stdout=log, stderr=subprocess.STDOUT)
    def scenario(name):
        path = Path(config['controlFile']); previous = json.loads(path.read_text())
        temp = path.with_suffix('.next'); temp.write_text(json.dumps({'seq': previous['seq'] + 1, 'scenario': name})); os.replace(temp, path)
        time.sleep(6)
    wanted = set(args.steps.split(','))
    previous_summary = OUTPUT / 'summary.json'
    summary = [entry for entry in json.loads(previous_summary.read_text()) if entry['step'] not in wanted] if previous_summary.exists() else []
    for name, value, method in STEPS:
        if name not in wanted:
            continue
        if name == 'offline':
            scenario('approval')
        if value:
            scenario(value)
        if name == 'offline':
            time.sleep(22)
        result = OUTPUT / (name + '-' + str(int(time.time())) + '.xcresult')
        log_path = OUTPUT / (name + '.log')
        command = base + ['test-without-building', '-parallel-testing-enabled', 'NO',
                          '-only-testing:AIWatchUITests/CloudAcceptanceTests/' + method, '-resultBundlePath', str(result)]
        with log_path.open('w') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
            if name == 'push':
                deadline = time.monotonic() + 100
                while process.poll() is None and time.monotonic() < deadline:
                    if 'AIWATCH_QA_PUSH_READY' in log_path.read_text(errors='replace'):
                        payload = OUTPUT / 'simulated-push.json'
                        payload.write_text(json.dumps({'Simulator Target Bundle': 'app.aiwatch.mobile', 'aps': {'alert': {
                            'title-loc-key': 'ai_watch_low_quota_title', 'loc-key': 'ai_watch_notice_body'}, 'sound': 'default'},
                            'type': 'low-quota', 'provider': 'codex'}))
                        run(['xcrun', 'simctl', 'push', simulator, 'app.aiwatch.mobile', str(payload)], stdout=subprocess.DEVNULL)
                        break
                    time.sleep(1)
            code = process.wait()
        evidence = json.loads(Path(config['evidenceFile']).read_text())
        action = None
        if name in ['answer', 'approve', 'deny']:
            latest = next(e for e in reversed(evidence['events']) if e.get('type') == 'scenario' and e.get('scenario') == value)
            action = next((e for e in reversed(evidence['events']) if e.get('type') == 'synthetic-action' and e.get('kind') == name and e.get('requestId') in latest.get('requestIds', []) and e.get('status') == 'succeeded'), None)
        passed = code == 0 and (name not in ['answer', 'approve', 'deny'] or action is not None)
        attachments = OUTPUT / ('attachments-' + result.stem)
        summary.append({'step': name, 'passed': passed, 'uiExitCode': code, 'result': result.name, 'attachments': attachments.name, 'syntheticActionConfirmed': action is not None})
        (OUTPUT / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(('PASS ' if passed else 'FAIL ') + name, flush=True)
        if not passed:
            return 1
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(result), '--output-path', str(attachments)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
