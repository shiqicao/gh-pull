import test from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture } from './browser-fixture.mjs';

test('age backgrounds retain their weekly tint and fade toward neutral in both themes', async t => {
  const now = Date.UTC(2026, 9, 28);
  const ages = [0, 0.25, 0.5, 1, 2, 4, 7, 14, 30, 365];
  const items = ages.map(days => ({ id: `age-${days}`, number: days + 1, title: `Age ${days}`, repo: 'example/demo', author: 'alice', status: 'OPEN', checks: 'NONE', review: 'NONE', labels: [], reviewers: [], additions: 0, deletions: 0, createdAt: '2026-01-01', updatedAt: new Date(now - days * 86400000).toISOString() }));
  const list = async () => ({ viewer: 'alice', items, total: items.length, pageInfo: { hasNextPage: false } });
  list.viewer = async () => 'alice';
  const { page, origin } = await browserFixture(t, { list, savedViews: { list: async () => [] } });
  await page.clock.install({ time: now });
  await page.goto(origin);
  await page.locator('.updated-time').first().waitFor();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    const colors = await page.evaluate(() => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      const rgb = (color, filter = 'none') => { ctx.filter = filter; ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.background = 'var(--color-neutral-bg)';
      const neutral = rgb(getComputedStyle(probe).backgroundColor);
      probe.remove();
      const badges = [...document.querySelectorAll('.updated-time')];
      return { neutral, text: badges.map(el => { const content = getComputedStyle(el.querySelector('.age-content')); return rgb(content.color, content.filter); }), backgrounds: badges.map(el => rgb(getComputedStyle(el).backgroundColor)), filters: badges.map(el => getComputedStyle(el).filter), contentFilter: getComputedStyle(badges[1].querySelector('.age-content')).filter };
    });
    const fresh = colors.backgrounds[0], week = colors.backgrounds[ages.indexOf(7)], old = colors.backgrounds[ages.indexOf(30)];
    week.forEach((value, i) => assert.ok(Math.abs(value - (fresh[i] + colors.neutral[i]) / 2) <= 1, `${colorScheme}: weekly background half-life`));
    const distance = rgb => rgb.reduce((sum, value, i) => sum + Math.abs(value - colors.neutral[i]), 0);
    assert.ok(distance(old) < distance(week) && distance(week) < distance(fresh));
    assert.ok(colors.filters.every(filter => filter === 'none'));
    const luminance = rgb => rgb.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    colors.text.forEach((text, i) => {
      const a = luminance(text), b = luminance(colors.backgrounds[i]);
      const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(contrast >= 4.5, `${colorScheme}, age ${ages[i]} days: ${contrast.toFixed(2)}:1`);
    });
    assert.match(colors.contentFilter, /saturate\(/);
    if (process.env.GH_PULL_SCREENSHOTS) await page.screenshot({ path: `/tmp/gh-pull-age-review-${colorScheme}.png` });
  }
});
