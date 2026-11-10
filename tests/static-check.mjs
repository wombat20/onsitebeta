/* 정적 검사
   1) node --check js/*.js
   2) beta-master.html · beta-operator.html 의 인라인 <script> 를 모두 꺼내 node --check
   3) 금지어 검사 (beta-*.html · js/ 에서 0건이어야 해요)
   4) 서비스 키·비밀번호 같은 비밀값이 저장소 파일에 없는지 확인
   5) 공개되는 HTML(테스트 하네스 포함)이 주소 값으로 서버 주소나 실제 행사 코드를 바꾸지 않는지
   실행: node tests/static-check.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from './lib/env.mjs';

let fail = 0;
const ok = m => console.log('  ok  ' + m);
const bad = m => { fail++; console.log('  FAIL ' + m); };
const check = f => { try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr || e.message); } };

console.log('[1] node --check js/*.js');
const jsDir = path.join(REPO, 'js');
const jsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).map(f => path.join(jsDir, f));
for (const f of jsFiles) { const e = check(f); e ? bad(`${path.relative(REPO, f)}\n${e}`) : ok(path.relative(REPO, f)); }

console.log('[2] inline <script> → node --check');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onsite-static-'));
for (const html of ['beta-master.html', 'beta-operator.html']) {
  const src = fs.readFileSync(path.join(REPO, html), 'utf8');
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m, i = 0, n = 0;
  while ((m = re.exec(src))) {
    i++;
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    n++;
    const f = path.join(tmp, `${html.replace(/\W/g, '_')}_${i}.js`);
    fs.writeFileSync(f, m[2]);
    const e = check(f); e ? bad(`${html} script #${i}\n${e}`) : ok(`${html} inline script #${i} (${m[2].length.toLocaleString()} chars)`);
  }
  if (!n) bad(`${html}: inline script 없음`);
  /* 엔진·저장 스크립트 순서 */
  const a = src.indexOf('js/onsite-engine.js'), b = src.indexOf('js/onsite-store.js'), c = src.indexOf('window.ONSITE_APP=');
  (c >= 0 && a > c && b > a) ? ok(`${html}: ONSITE_APP → engine → store 순서`) : bad(`${html}: 스크립트 순서 확인 필요`);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log('[3] 금지어 (beta-*.html · js/)');
const targets = fs.readdirSync(REPO).filter(f => /^beta-.*\.html$/.test(f)).map(f => path.join(REPO, f)).concat(jsFiles);
const GUARDS = ['initPw', 'Onsite2026', 'SYNC_URL', 'EventSource', 'mkRoster', 'PLAN0', 'sh0(', 'timeline(J', '.ino', 'J.place', 'blocks/'];
for (const g of GUARDS) {
  const hits = [];
  for (const f of targets) fs.readFileSync(f, 'utf8').split('\n').forEach((l, k) => { if (l.includes(g)) hits.push(`${path.relative(REPO, f)}:${k + 1}`); });
  hits.length ? bad(`'${g}' ${hits.length}건: ${hits.slice(0, 5).join(', ')}`) : ok(`'${g}' 0건`);
}

console.log('[4] 비밀값 검사 (저장소 전체 · .git·vendor 제외)');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return ['.git', 'node_modules', 'vendor'].includes(e.name) ? [] : walk(p);
  return /\.(html|js|mjs|cjs|json|md|sql|ts|toml|env|txt|csv)$/i.test(e.name) || e.name.startsWith('.env') ? [p] : [];
});
const SECRET = [/service_role["'\s:=]+ey[A-Za-z0-9_-]{20,}/i, /sb_secret_[A-Za-z0-9_-]{10,}/, /eyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S{10,}/];
let sHits = 0;
for (const f of walk(REPO)) {
  const t = fs.readFileSync(f, 'utf8');
  for (const re of SECRET) if (re.test(t)) { sHits++; bad(`비밀값 의심: ${path.relative(REPO, f)} (${re})`); }
}
if (!sHits) ok('service_role / sb_secret / JWT 형태 값 없음');

console.log('[5] 공개되는 HTML 이 주소 값으로 서버 주소·실제 행사 코드를 바꾸지 않는지 (로그인 정보 유출 방지)');
/* GitHub Pages 는 저장소 전체를 공개하고, 같은 사이트의 HTML 은 브라우저 저장소(로그인 정보)를 같이 써요 */
const htmls = walk(REPO).filter(f => f.endsWith('.html'));
for (const f of htmls) {
  const t = fs.readFileSync(f, 'utf8'); const rel = path.relative(REPO, f);
  if (/CONFIG\.SB_URL\s*=[^=]/.test(t)) bad(`${rel}: CONFIG.SB_URL 을 바꾸는 코드가 있어요`);
  else if (/CONFIG\.code\s*=[^=]/.test(t) && !/\^TEST\[A-Z0-9-\]/.test(t)) bad(`${rel}: CONFIG.code 를 TEST… 제한 없이 바꿔요`);
  else ok(`${rel}`);
}

console.log(fail ? `\nSTATIC: ${fail}건 실패` : '\nSTATIC: 모두 통과');
process.exit(fail ? 1 : 0);
