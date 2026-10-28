import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

test('age backgrounds retain their weekly tint and fade toward neutral in both themes', async t => {
  const now = Date.UTC(2026, 9, 28);
  const items = [0, 7, 30].map(days => ({ id: `age-${days}`, number: days + 1, title: `Age ${days}`, repo: 'example/demo', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: new Date(now - days * 86400000).toISOString() }));
  const list = async () => ({ viewer: 'alice', items, total: 3, pageInfo: { hasNextPage: false } });
  list.viewer = async () => 'alice';
  const { page, origin } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  await page.clock.install({ time: now });
  await page.goto(origin);
  await page.locator('.updated-time').first().waitFor();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const colors = await page.evaluate(() => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.background = 'var(--color-neutral-bg)';
      const neutral = rgb(getComputedStyle(probe).backgroundColor);
      probe.remove();
      const badges = [...document.querySelectorAll('.updated-time')];
      return { neutral, backgrounds: badges.map(el => rgb(getComputedStyle(el).backgroundColor)), filters: badges.map(el => getComputedStyle(el).filter), contentFilter: getComputedStyle(badges[1].querySelector('.age-content')).filter };
    });
    const [fresh, week, old] = colors.backgrounds;
    week.forEach((value, i) => assert.ok(Math.abs(value - (fresh[i] + colors.neutral[i]) / 2) <= 1, `${colorScheme}: weekly background half-life`));
    const distance = rgb => rgb.reduce((sum, value, i) => sum + Math.abs(value - colors.neutral[i]), 0);
    assert.ok(distance(old) < distance(week) && distance(week) < distance(fresh));
    assert.deepEqual(colors.filters, ['none', 'none', 'none']);
    assert.match(colors.contentFilter, /saturate\(/);
    await page.screenshot({ path: `/tmp/gh-pull-age-review-${colorScheme}.png` });
  }
});
