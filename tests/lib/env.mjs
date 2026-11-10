/* 테스트 공용 경로·의존성 로더
   - 저장소에는 package.json 을 두지 않아요. npm 패키지(xlsx, playwright-core 등)는
     ONSITE_NPM_DIR 에 설치된 node_modules 를 그대로 써요.
   - Playwright 는 전역 설치(require('playwright'))를 먼저 찾고, 없으면 ONSITE_NPM_DIR 의 playwright-core 를 써요. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/* ▼ 환경에 맞게 바꾸거나 환경변수로 지정하세요 */
export const NPM_DIR = process.env.ONSITE_NPM_DIR
  || '/tmp/claude-0/-home-user-onsitebeta/c24c3d43-e67c-55ed-81ee-944779fc64fb/scratchpad/npm/node_modules';
export const SCRATCH = process.env.ONSITE_SCRATCH
  || '/tmp/claude-0/-home-user-onsitebeta/c24c3d43-e67c-55ed-81ee-944779fc64fb/scratchpad';
/* 원본(리팩터링 전) 마스터 v2 사본 · golden.mjs 가 이 파일로 기준값을 만들어요 */
export const GOLDEN_SRC = process.env.ONSITE_GOLDEN_SRC || path.join(SCRATCH, 'golden', 'master-v2-orig.html');
export const SHOTS_DIR = process.env.ONSITE_SHOTS || path.join(SCRATCH, 'shots');

export const TESTS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO = path.dirname(TESTS_DIR);
export const FIXTURES = path.join(TESTS_DIR, 'fixtures');
export const GOLDEN_JSON = path.join(TESTS_DIR, 'golden', 'golden.json');

const req = createRequire(import.meta.url);
export function requireFrom(name) {
  const tries = [name, path.join(NPM_DIR, name)];
  for (const t of tries) { try { return req(t); } catch (e) { /* next */ } }
  throw new Error(`모듈 ${name} 을(를) 찾지 못했어요 · ONSITE_NPM_DIR=${NPM_DIR}`);
}
export function loadXLSX() { return req(path.join(NPM_DIR, 'xlsx')); }
export function loadPlaywright() {
  const cands = ['playwright'];
  try { cands.push(path.join(req('node:child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch (e) {}
  cands.push(path.join(NPM_DIR, 'playwright-core'));
  for (const c of cands) { try { return req(c); } catch (e) { /* next */ } }
  throw new Error('playwright 를 찾지 못했어요 · npm i -g playwright 또는 ONSITE_NPM_DIR 에 playwright-core 설치');
}
export const XLSX_JS = path.join(NPM_DIR, 'xlsx', 'dist', 'xlsx.full.min.js');
export function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
