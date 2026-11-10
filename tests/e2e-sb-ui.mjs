/* 온라인 모드 화면 E2E (실제 Supabase · TEST 행사 · 마스터 PC + 운영자 휴대폰)
   실제 화면을 눌러서 확인해요:
   마스터 로그인 → 엑셀 시간표 업로드 → 운영자 초대(안내문) → 운영자가 초대 링크로 접속(아이디 자동 입력)
   → 임시 비밀번호 로그인 → 첫 비밀번호 변경 → 명단 도착 → 운영자 접수 → 마스터 반영
   → 마스터 DELAY → 운영자 반영 → 역할 변경 → 사용 중지(강제 로그아웃) → 다시 사용 + 재발급 → 재로그인
   → 운영자 비밀번호 변경(마이) → 초기화 → 활동 로그 내보내기 → 운영자 삭제 → 영구 삭제 → 로그아웃
   자격 증명: ONSITE_SCRATCH/secrets/qa.json (저장소에 없음) · 실행: node tests/e2e-sb-ui.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/serve.mjs';
import { REPO, SCRATCH, FIXTURES, SHOTS_DIR, loadPlaywright } from './lib/env.mjs';

const qa = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'secrets', 'qa.json'), 'utf8'));
const MASTER = qa.qa_master;
const { chromium, devices } = loadPlaywright();
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`); return cond; };
const tempFrom = msg => ((msg || '').match(/임시 비밀번호: ([A-Za-z0-9-]+)/) || [])[1] || '';
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const srv = await startServer([{ prefix: '/', dir: REPO }], 0);
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined });
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', e => errors.push(`${tag}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::|WebSocket|realtime/i.test(m.text())) errors.push(`${tag} console: ${m.text()}`); });
  return page;
};
const block = async ctx => ctx.route(/fonts\.googleapis|cdn\.jsdelivr|cdnjs\.cloudflare|\/fonts\//, r => r.abort());

const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await block(mctx);
const M = watch(await mctx.newPage(), 'master');
const octx = await browser.newContext({ ...devices['iPhone 13'] });
await block(octx);
const O = watch(await octx.newPage(), 'operator');
const BASE = srv.url;
let opId = '', temp = '', opPw = 'Phone2026ab';
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 300 }).then(() => true, () => false);

try {
  // 1. 마스터 로그인
  await M.goto(`${BASE}/beta-master.html?ev=TEST&t=10:00`);
  await M.locator('#lg-id').waitFor({ timeout: 20000 });
  ok('마스터: 연결 후 로그인 화면', true);
  await M.fill('#lg-pw', 'wrong-password-1');
  await M.fill('#lg-id', MASTER.email);
  await M.click('[data-act="login"]');
  ok('마스터: 틀린 비밀번호 안내', await M.locator('.lg-err', { hasText: '맞지 않아요' }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await M.fill('#lg-id', MASTER.email); await M.fill('#lg-pw', MASTER.password);
  await M.click('[data-act="login"]');
  ok('마스터: 로그인 → 현장 운영', await M.locator('#nav .nav-item').first().waitFor({ timeout: 20000 }).then(() => true, () => false));
  ok('마스터: 연결 상태 표시', await until(M, () => /연결됨|실시간/.test(document.querySelector('#nav .syncdot')?.textContent || '')));

  // 2. 엑셀 업로드
  await M.click('#nav [data-p="sched"]');
  await M.setInputFiles('#fileIn', path.join(FIXTURES, 'timetable.xlsx'));
  await M.locator('.modal [data-act="applyTT"]').click({ timeout: 20000 });
  ok('마스터: 엑셀 시간표 적용', await M.locator('.callout.ok').waitFor({ timeout: 10000 }).then(() => true, () => false));
  ok('마스터: 온라인 모드에서는 시간표 링크 버튼 없음', (await M.locator('[data-act="ttShare"]').count()) === 0);
  const nos = await M.evaluate(() => J.roster.map(r => r.no));
  ok('시간표 인원', nos.length === 21, `${nos.length}명`);
  ok('시간표가 서버에 저장', await until(M, () => STORE.pending === 0, null, 15000));

  // 3. 운영자 초대
  await M.click('#nav [data-p="people"]');
  await M.click('[data-act="opAdd"]');
  await M.fill('#no-n', '화면테스트'); await M.selectOption('#no-r', '접수'); await M.fill('#no-p', '010-0000-0077');
  await M.click('[data-act="opCreate"]');
  await M.locator('.modal .mh b', { hasText: '초대 완료' }).waitFor({ timeout: 20000 });
  const share = await M.evaluate(() => window._share);
  opId = (share.link.match(/#id=([^&]+)/) || [])[1] || '';
  temp = tempFrom(share.msg);
  ok('초대 안내문: 주소+아이디+임시 비밀번호', /^TEST-S\d{2}$/.test(opId) && /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(temp) && share.msg.includes(opId), `${opId}`);
  ok('초대 링크에 비밀번호·지원자 정보 없음', !share.link.includes(temp) && !/tt=|inv=/.test(share.link) && share.link.length < 200);
  await M.screenshot({ path: path.join(SHOTS_DIR, 'sb-master-invite.png') });
  await M.click('.modal [data-act="closeModal"]');
  ok('운영자 목록에 표시(첫 로그인 전·임시 비밀번호)', await until(M, id => { const r = [...document.querySelectorAll('td.mono')].map(t => t.textContent); return r.includes(id) && document.body.textContent.includes('첫 로그인 전'); }, opId));

  // 4. 운영자: 초대 링크로 접속 → 아이디 자동 입력 → 임시 비밀번호 로그인 → 변경
  await O.goto(`${BASE}/beta-operator.html?ev=TEST&t=10:00#id=${opId}`);
  await O.locator('#lg-id').waitFor({ timeout: 20000 });
  // 아이디(#id=)는 로그인할 때까지 주소에 남아요 (카카오톡 '다른 브라우저로 열기'에도 아이디가 따라가게) · 로그인하면 지워요
  ok('운영자: 초대 링크로 아이디 자동 입력(로그인 전까지 주소에 아이디 유지)', (await O.inputValue('#lg-id')) === opId && (await O.evaluate(() => location.hash)) === `#id=${opId}`);
  await O.fill('#lg-pw', temp);
  await O.click('[data-act="login"]');
  await O.locator('#np1').waitFor({ timeout: 20000 });
  ok('운영자: 첫 로그인 → 비밀번호 변경 화면', true);
  await O.fill('#np1', 'onlyletters'); await O.fill('#np2', 'onlyletters'); await O.click('[data-act="pwSave"]');
  ok('운영자: 규칙에 안 맞는 비밀번호 안내', await O.locator('.ol-err', { hasText: '영문과 숫자' }).waitFor({ timeout: 8000 }).then(() => true, () => false));
  await O.fill('#np1', opPw); await O.fill('#np2', opPw); await O.click('[data-act="pwSave"]');
  ok('운영자: 변경 후 운영보드', await O.locator('#tabbar .tab').first().waitFor({ timeout: 20000 }).then(() => true, () => false));
  ok('운영자: 로그인 후 주소의 아이디(#id=) 지움', !(await O.evaluate(() => location.hash)));
  await O.click('[data-act="tab"][data-t="list"]');
  ok('운영자: 명단 도착(21명)', await until(O, () => document.querySelectorAll('.prow').length === 21));
  await O.screenshot({ path: path.join(SHOTS_DIR, 'sb-operator-list.png') });
  ok('마스터: 운영자 상태 비밀번호 설정 완료 · 접속 중', await until(M, () => document.body.textContent.includes('비밀번호 설정 완료') && document.body.textContent.includes('본인 변경 완료') && document.body.textContent.includes('● 접속 중')));

  // 5. 운영자 접수 → 마스터 반영
  const no = nos[0];
  await O.click(`.prow[data-no="${no}"]`);
  await O.click(`[data-act="setSt"][data-v="접수"]`);
  ok('운영자: 접수 + 전자기기 번호 자동', await until(O, n => A(n).status === '접수' && !!A(n).device, no));
  await O.click('[data-act="closeSheet"]').catch(() => {});
  await M.click('#nav [data-p="monitor"]');
  await M.click('[data-act="monRoom"][data-i="all"]');
  ok('마스터: 운영자 접수 반영(표)', await until(M, n => { const s = document.querySelector(`[data-app="${n}:status"]`); return s && s.value === '접수'; }, no));

  // 6. 마스터 DELAY → 운영자 반영
  const before = await O.evaluate(n => sessionOf(n).x.s, nos[3]);
  const firstOfRoom = await M.evaluate(n => { const s = sessionOf(n); return s.room.items[0].members[0]; }, nos[3]);
  await M.evaluate(n => { const el = document.querySelector(`[data-app="${n}:delay"]`); el.value = '10'; el.dispatchEvent(new Event('change', { bubbles: true })); }, firstOfRoom);
  ok('마스터 DELAY 10 → 운영자 일정 이동', await until(O, a => sessionOf(a.n).x.s > a.before, { n: nos[3], before }), `${firstOfRoom}`);

  // 7. 역할 변경 → 운영자 마이 갱신
  await M.click('#nav [data-p="people"]');
  await M.selectOption(`[data-oprole="${opId}"]`, '인솔');
  await O.click('[data-act="tab"][data-t="my"]');
  ok('역할 변경 → 운영자 마이에 인솔', await until(O, () => document.querySelector('.profile .rl')?.textContent.includes('인솔')));

  // 8. 운영자 비밀번호 변경(마이)
  await O.click('[data-act="pwSheet"]');
  const pw2 = 'Phone2026cd';
  await O.fill('#op0', opPw); await O.fill('#op1', pw2); await O.fill('#op2', pw2); await O.click('[data-act="pwChange"]');
  ok('운영자: 마이에서 비밀번호 변경', await O.locator('.toast', { hasText: '비밀번호를 바꿨어요' }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  opPw = pw2;

  // 9. 사용 중지(확인창) → 강제 로그아웃
  await M.click(`[data-act="opToggle"][data-id="${opId}"]`);
  await M.click('.modal [data-act="opToggleDo"]');
  ok('사용 중지 → 운영자 로그인 화면(안내)', await O.locator('.ol-err', { hasText: '사용 중지' }).waitFor({ timeout: 25000 }).then(() => true, () => false));
  ok('사용 중지 후 운영자 기기에서 명단 삭제', await O.evaluate(() => !J.ready && !localStorage.getItem(STORE_KEY + ':outbox')));

  // 10. 다시 사용 + 재발급 → 새 임시 비밀번호로 로그인 → 변경
  await until(M, id => !!document.querySelector(`[data-act="opToggle"][data-id="${id}"]`), opId);
  await M.click(`[data-act="opToggle"][data-id="${opId}"]`);
  await until(M, id => (document.querySelector(`[data-act="opToggle"][data-id="${id}"]`)?.textContent || '').includes('사용 중지'), opId);
  await M.click(`[data-act="opReset"][data-id="${opId}"]`);
  await M.click('.modal [data-act="opResetDo"]');
  await M.locator('.modal .mh b', { hasText: '재발급 완료' }).waitFor({ timeout: 20000 });
  const temp2 = tempFrom(await M.evaluate(() => window._share.msg));
  ok('재발급: 새 임시 비밀번호', !!temp2 && temp2 !== temp);
  await M.click('.modal [data-act="closeModal"]');
  await O.fill('#lg-id', opId); await O.fill('#lg-pw', opPw); await O.click('[data-act="login"]');
  ok('재발급 후 이전 비밀번호 거부', await O.locator('.ol-err', { hasText: '맞지 않아요' }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  await O.fill('#lg-pw', temp2); await O.click('[data-act="login"]');
  await O.locator('#np1').waitFor({ timeout: 20000 });
  opPw = 'Phone2026ef';
  await O.fill('#np1', opPw); await O.fill('#np2', opPw); await O.click('[data-act="pwSave"]');
  ok('재발급 → 재로그인 → 변경 → 운영보드', await O.locator('#tabbar .tab').first().waitFor({ timeout: 20000 }).then(() => true, () => false));
  ok('재로그인 후 이전 접수 기록 유지', await until(O, n => A(n).status === '접수', no));

  // 11. 초기화 → 운영자 기록 비움
  await M.click('#nav [data-p="admin"]');
  await M.click('[data-act="reset"]'); await M.fill('#rs-c', '초기화'); await M.click('.modal [data-act="doReset"]');
  ok('마스터 초기화 → 운영자 기록 비움(시간표 유지)', await until(O, n => A(n).status === '' && J.ready, no, 25000));

  // 12. 활동 로그 내보내기
  const dl = M.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await M.click('[data-act="logCsv"]');
  const d = await dl;
  ok('활동 로그 CSV 내보내기', !!d);

  // 13. 운영자 삭제 → 운영자 강제 로그아웃
  await M.click('#nav [data-p="people"]');
  await M.click(`[data-act="opDel"][data-id="${opId}"]`); await M.click('.modal [data-act="opDelDo"]');
  if (!ok('운영자 삭제 → 운영자 로그아웃', await O.locator('#lg-id').waitFor({ timeout: 25000 }).then(() => true, () => false)))
    console.log('   DEBUG operator', JSON.stringify(await O.evaluate(() => ({ auth: S.auth, me: STORE.auth.me, sync: SYNC.state, pending: STORE.pending, main: document.querySelector('#main').innerText.slice(0, 160) }))));
  ok('마스터 목록에서 사라짐', await until(M, id => ![...document.querySelectorAll('td.mono')].some(t => t.textContent === id), opId));

  // 14. 영구 삭제(TEST 행사) → 시간표 비움
  await M.click('#nav [data-p="admin"]');
  await M.click('[data-act="purge"]');
  await M.click('.modal [data-act="doPurge"]');
  ok('영구 삭제: 확인 문구 없으면 거부', await M.locator('.toast', { hasText: '영구 삭제' }).waitFor({ timeout: 5000 }).then(() => true, () => false));
  await M.fill('#pg-c', '영구 삭제'); await M.click('.modal [data-act="doPurge"]');
  ok('영구 삭제 → 시간표·기록 비움', await until(M, () => !J.ready, null, 25000));

  // 15. 로그아웃 → 새로고침해도 로그인 화면
  await M.click('[data-act="logout"]');
  if (!ok('마스터 로그아웃', await M.locator('#lg-id').waitFor({ timeout: 15000 }).then(() => true, () => false)))
    console.log('   DEBUG master', JSON.stringify(await M.evaluate(() => ({ pending: STORE.pending, outbox: localStorage.getItem(STORE_KEY + ':outbox'), sync: SYNC.state, toast: document.querySelector('.toast')?.textContent || '' }))));
  await M.reload(); await M.locator('#lg-id').waitFor({ timeout: 20000 });
  ok('로그아웃 후 새로고침 → 로그인 화면 유지(캐시 없음)', await M.evaluate(() => !localStorage.getItem(STORE_KEY) || !JSON.parse(localStorage.getItem(STORE_KEY)).roster));
} catch (e) {
  ok('예외 없이 완료', false, (e && e.stack) || String(e));
  await M.screenshot({ path: path.join(SHOTS_DIR, 'sb-fail-master.png') }).catch(() => {});
  await O.screenshot({ path: path.join(SHOTS_DIR, 'sb-fail-operator.png') }).catch(() => {});
} finally {
  ok('페이지 오류 없음', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); await srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
