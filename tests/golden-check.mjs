/* 리팩터링 후 엔진이 원본과 똑같이 계산하는지 비교
   새 beta-master.html · beta-operator.html (?local=1&t=10:00) 에서 golden.mjs 와 같은 계산을 하고
   tests/golden/golden.json 과 깊은 비교(deep-equal)해요.
   실행: node tests/golden-check.mjs */
import fs from 'node:fs';
import { REPO, GOLDEN_JSON, loadPlaywright } from './lib/env.mjs';
import { startServer } from './lib/serve.mjs';
import { computeGolden, blockExternal, diff } from './lib/golden-compute.mjs';

const golden = JSON.parse(fs.readFileSync(GOLDEN_JSON, 'utf8'));
const { chromium } = loadPlaywright();
const srv = await startServer([{ prefix: '/', dir: REPO }]);
const browser = await chromium.launch();
let fail = 0;
try {
  for (const [file, loadX] of [['beta-master.html', 'loadXLSX'], ['beta-operator.html', 'tag']]) {
    const ctx = await browser.newContext();
    await blockExternal(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
    await page.goto(`${srv.url}/${file}?local=1&t=10:00`);
    const mode = await page.evaluate(() => ({ app: STORE.app, mode: STORE.mode, key: STORE_KEY, sync: syncLabel()[0] }));
    if (loadX === 'loadXLSX') await page.evaluate(() => loadXLSX());   /* 마스터: vendor 사본을 실제 로더로 */
    else await page.addScriptTag({ url: `${srv.url}/vendor/xlsx-0.18.5.full.min.js` });
    const g = await computeGolden(page, srv.url);
    const d = diff(golden, g);
    if (errors.length) { fail++; console.log(`FAIL ${file}: page errors\n  ${errors.join('\n  ')}`); }
    if (d.length) { fail++; console.log(`FAIL ${file}: golden 과 달라요 (${d.length}+)\n  ${d.join('\n  ')}`); }
    else console.log(`ok   ${file} · ${mode.app}/${mode.mode} · ${mode.key} · "${mode.sync}" · golden 일치 (rows ${g.xlsx.rows.length}, conduct ${g.conduct.length}, after-delay ${g.after.map(a => a.roomDelay).join('/')})`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
console.log(fail ? `\nGOLDEN: ${fail}건 실패` : '\nGOLDEN: 모두 일치');
process.exit(fail ? 1 : 0);
