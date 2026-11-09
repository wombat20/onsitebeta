/* 로컬 모드 테스트 한 번에: static-check → golden-check → e2e-local
   실행: node tests/run-local.mjs */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TESTS_DIR } from './lib/env.mjs';

const steps = ['static-check.mjs', 'golden-check.mjs', 'e2e-local.mjs'];
const out = [];
for (const s of steps) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [path.join(TESTS_DIR, s)], { stdio: 'inherit' });
  out.push([s, r.status === 0]);
}
console.log('\n=== 요약 ===');
out.forEach(([s, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}`));
process.exit(out.every(([, ok]) => ok) ? 0 : 1);
