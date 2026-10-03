import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

if (process.env.AI_WATCH_LIVE_QA !== '1') throw new Error('Set AI_WATCH_LIVE_QA=1 to query the locally signed-in accounts.');
const profile = await mkdtemp(path.join(tmpdir(), 'ai-watch-live-work-zcode-'));
await writeFile(path.join(profile, 'preferences.json'), JSON.stringify({ enabledProviders: ['zcode', 'kimi'], kimiSource: 'work', locked: false }));
const watched = [path.join(homedir(), '.zcode', 'v2', 'credentials.json'), path.join(homedir(), '.zcode', 'v2', 'setting.json'),
  path.join(homedir(), 'Library', 'Application Support', 'kimi-desktop', 'daimon-share', 'daimon', 'config.json')];
const fingerprint = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const before = await Promise.all(watched.map(fingerprint));
let app;
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AI_WATCH_TEST_PROFILE: profile, AI_WATCH_TEST_STATUS: '' } });
  if (process.env.AI_WATCH_QA_PROXY) {
    const proxy = new URL(process.env.AI_WATCH_QA_PROXY);
    assert.equal(proxy.protocol, 'http:');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname));
    assert.equal(proxy.username, ''); assert.equal(proxy.password, '');
    await app.evaluate(async ({ session }, rules) => session.defaultSession.setProxy({ proxyRules: rules }), proxy.origin);
  }
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: 'AI WATCH', exact: true }).waitFor();
  const status = await page.evaluate(() => window.panel.refreshStatus());
  for (const id of ['zcode', 'kimi']) {
    assert.equal(status[id].connection, 'ready', `${id}: ${status[id].detail}`);
    assert.equal(status[id].source, 'account');
    assert.ok(status[id].plan.name);
    assert.ok(status[id].quotas.length > 0);
    assert.ok(status[id].quotas.every(quota => !quota.stale));
  }
  assert.equal(status.kimi.kimiSource, 'work');
  assert.equal(status.kimi.activity, 'unknown');
  const selected = Object.fromEntries(['zcode', 'kimi'].map(id => [id, status[id]]));
  assert.doesNotMatch(JSON.stringify(selected), /accessToken|refreshToken|customerNumber|userId|apiKey|signature|\/Users\//i);
  for (const id of ['zcode', 'kimi']) {
    const card = page.locator(`.provider-card[data-provider="${id}"]`);
    await expect(card).toContainText(status[id].plan.name);
    for (const quota of status[id].quotas) {
      await expect(card).toContainText(quota.period);
      if (quota.remaining !== null) await expect(card).toContainText(`${quota.remaining}%`);
    }
    const geometry = await card.evaluate(element => {
      const bounds = node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; };
      return { tools: bounds(element.querySelector('.quota-tools')), list: bounds(element.querySelector('.quota-list')),
        footer: bounds(element.querySelector('.task-line')), rows: [...element.querySelectorAll('.quota')].map(bounds) };
    });
    assert.ok(geometry.tools.bottom <= geometry.list.top + 1, `${id}: quota toolbar overlap`);
    assert.ok(geometry.list.bottom <= geometry.footer.top + 1, `${id}: quota footer overlap`);
    assert.ok(geometry.rows.every(row => row.top >= geometry.list.top - 1 && row.bottom <= geometry.list.bottom + 1),
      `${id}: quota rows overflow`);
  }
  await expect(page.getByRole('heading', { name: 'Kimi Work', exact: true })).toBeVisible();
  assert.deepEqual(await Promise.all(watched.map(fingerprint)), before, 'Provider files changed during the check; repeat after the clients settle.');
  const output = '.local/qa/kimi-zcode-live.png';
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output });
  console.log(JSON.stringify({ live: true, providerFilesUnchanged: true, screenshot: output,
    providers: ['zcode', 'kimi'].map(id => ({ id, source: status[id].source, connection: status[id].connection,
      plan: status[id].plan.name, quotas: status[id].quotas, activity: status[id].activity })) }));
  if (process.env.AI_WATCH_KEEP_OPEN === '1') {
    console.log('The live panel remains open. Close it normally when finished.');
    await new Promise(resolve => app.process().once('exit', resolve));
  }
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
