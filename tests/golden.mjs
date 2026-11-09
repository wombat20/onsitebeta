/* 기준값(golden) 생성 · 리팩터링 전 원본 마스터 v2 로 계산해요
   실행: node tests/golden.mjs  →  tests/golden/golden.json
   원본 사본 위치: ONSITE_GOLDEN_SRC (기본: 스크래치패드 golden/master-v2-orig.html)
   원본이 없으면 git 에서 꺼내세요: git show 9e87d19:"beta-master (2).html" > <경로> */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, NPM_DIR, GOLDEN_SRC, GOLDEN_JSON, loadPlaywright, exists } from './lib/env.mjs';
import { startServer } from './lib/serve.mjs';
import { computeGolden, blockExternal } from './lib/golden-compute.mjs';

if (!exists(GOLDEN_SRC)) { console.error(`원본 사본이 없어요: ${GOLDEN_SRC}`); process.exit(2); }
const { chromium } = loadPlaywright();
const srv = await startServer([{ prefix: '/', dir: REPO }, { prefix: '/__golden/', dir: path.dirname(GOLDEN_SRC) }, { prefix: '/__npm/', dir: NPM_DIR }]);
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext();
  await blockExternal(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${srv.url}/__golden/${path.basename(GOLDEN_SRC)}?t=10:00`);
  await page.addScriptTag({ url: `${srv.url}/__npm/xlsx/dist/xlsx.full.min.js` });
  const g = await computeGolden(page, srv.url);
  if (errors.length) throw new Error('page errors: ' + errors.join(' | '));
  if (!g.csvEqualsXlsx) throw new Error('CSV 와 XLSX 파싱 결과가 달라요 · 픽스처를 확인해 주세요');
  fs.mkdirSync(path.dirname(GOLDEN_JSON), { recursive: true });
  fs.writeFileSync(GOLDEN_JSON, JSON.stringify(g, null, 1) + '\n');
  console.log(`golden 저장: ${path.relative(REPO, GOLDEN_JSON)} · ${g.xlsx.rows.length}명 · 면접실 ${g.rooms.map(r => `${r.name}(${r.items.length})`).join(', ')} · 행동 강령 ${g.conduct.length}건`);
  console.log(`  gap 행: ${g.plan.map(p => `${p.name} ${p.tlPlan.filter(x => x.kind === 'gap').length}`).join(', ')} · 변경 후 지연: ${g.after.map(a => `${a.name} ${a.roomDelay}`).join(', ')}`);
  console.log(`  broken: csv="${g.brokenCsv.errors[0]}" xlsx="${g.brokenXlsx.errors[0]}"`);
} finally {
  await browser.close();
  await srv.close();
}
