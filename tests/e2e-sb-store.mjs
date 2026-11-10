/* 온라인 모드 저장 계층 E2E (실제 Supabase · TEST 행사)
   - 화면 없이 tests/harness/sb-harness.html 두 개(마스터·운영자 컨텍스트)로
     로그인 → 계정 생성 → 첫 비밀번호 변경 → 시간표·접수·지연·행동강령 쓰기 → 상대편 반영(폴링 경로)
     → 동시 수정 병합 → 오프라인 대기열 재전송 → 초기화 → 사용 중지 시 강제 로그아웃 → 정리
   - 자격 증명: ONSITE_SCRATCH/secrets/qa.json (저장소에 없음)
   실행: node tests/e2e-sb-store.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/serve.mjs';
import { REPO, SCRATCH, FIXTURES, loadPlaywright } from './lib/env.mjs';

const qa = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'secrets', 'qa.json'), 'utf8'));
const findCred = o => { if (!o || typeof o !== 'object') return null; if (o.email && o.password && /qa-master/i.test(o.email)) return o; for (const v of Object.values(o)) { const r = findCred(v); if (r) return r; } return null; };
const MASTER = findCred(qa);
const DOMAIN = process.env.ONSITE_OP_DOMAIN || qa.op_email_domain || qa.OP_EMAIL_DOMAIN || (MASTER && MASTER.email.split('@')[1]);
if (!MASTER || !DOMAIN) { console.error('qa.json 에서 QA 마스터 계정/도메인을 찾지 못했어요'); process.exit(2); }

const { chromium } = loadPlaywright();
let pass = 0, fail = 0; const results = [];
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' · ' + extra : ''}`); console.log(results[results.length - 1]); };
async function waitFor(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - t0 > timeout) return null; await new Promise(r => setTimeout(r, 300)); }
}

const srv = await startServer([{ prefix: '/', dir: REPO }], 0);
const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined });
const errors = [];
async function openHarness(app) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${app}: ${e.message}`));
  const q = new URLSearchParams({ app, ev: 'TEST', dom: DOMAIN });   // 서버 주소는 하네스가 CONFIG.SB_URL 로 고정해요
  await page.goto(`${srv.url}/tests/harness/sb-harness.html?${q}`);
  return { ctx, page };
}

let opId = null;
const M = await openHarness('master');
const O = await openHarness('operator');
try {
  // 1. 마스터 로그인 + 동기화 시작
  const s0 = await M.page.evaluate(() => H.state());
  ok('온라인 모드로 시작', s0.mode === 'sb' && !s0.fatal, JSON.stringify(s0));
  const li = await M.page.evaluate(async c => { const r = await STORE.auth.signIn(c.email, c.password); if (r.ok) await STORE.startSync(); return r; }, MASTER);
  ok('QA 마스터 로그인', li.ok && !li.mustChange, li.message || '');
  ok('마스터 동기화 연결', !!(await waitFor(M.page, () => ['poll', 'live'].includes(SYNC.state))), await M.page.evaluate(() => SYNC.state));

  // 2. 운영자 계정 생성
  const co = await M.page.evaluate(() => STORE.admin.createOp({ name: '테스트운영', role: '접수', phone: '010-0000-0099' }));
  ok('운영자 초대(create_op)', co.ok && /^TEST-S\d{2}$/.test(co.id) && !!co.temp, co.message || co.id);
  opId = co.id;
  ok('마스터 화면에 운영자·임시 비밀번호 표시', !!(await waitFor(M.page, id => { const o = opList().find(x => x.id === id); return o && o.temp && o.mustChange; }, opId)));

  // 3. 운영자 첫 로그인 → 비밀번호 변경
  const ol = await O.page.evaluate(async a => STORE.auth.signIn(a.id, a.temp), { id: opId, temp: co.temp });
  ok('운영자 임시 비밀번호 로그인 → 변경 요구', ol.ok && ol.mustChange, ol.message || '');
  const weak = await O.page.evaluate(async t => STORE.auth.changePassword(t, 'abcdefgh'), co.temp);
  ok('약한 비밀번호 거부(서버)', !weak.ok, weak.message || '');
  const NEWPW = 'Field2026ok';
  const ch = await O.page.evaluate(async a => { const r = await STORE.auth.changePassword(a.t, a.n); if (r.ok) await STORE.startSync(); return r; }, { t: co.temp, n: NEWPW });
  ok('운영자 비밀번호 변경 + 동기화', ch.ok, ch.message || '');
  ok('운영자 연결', !!(await waitFor(O.page, () => ['poll', 'live'].includes(SYNC.state))));
  ok('변경 후 마스터 화면에서 임시 비밀번호 사라짐', !!(await waitFor(M.page, id => { const o = opList().find(x => x.id === id); return o && !o.temp && !o.mustChange; }, opId)));

  // 4. 시간표 업로드 → 운영자 반영
  const csv = fs.readFileSync(path.join(FIXTURES, 'timetable.csv'), 'utf8');
  const up = await M.page.evaluate(text => { const res = parseTimetable(parseCSV(text.replace(/^﻿/, ''))); dbSet('roster', { v: Date.now(), file: 'timetable.csv', at: stamp(), by: 'QA', labels: res.labels || {}, rows: res.rows }); return { n: res.rows.length, err: res.errors }; }, csv);
  ok('마스터 시간표 적용', up.n > 0 && !up.err.length, `${up.n}명`);
  const seen = await waitFor(O.page, n => J.ready && J.roster.length === n, up.n, 20000);
  ok('운영자 화면에 시간표 도착', !!seen);
  const nos = await M.page.evaluate(() => J.roster.map(r => r.no));

  // 5. 운영자 접수 → 마스터 반영 (+로그)
  await O.page.evaluate(no => setApp(no, { status: '접수', device: '1', ck: { at: '10:00', how: '수동', by: '테스트운영' } }, '테스트운영 · 운영관리자', `${no} 접수`), nos[0]);
  ok('운영자 접수 → 마스터 반영', !!(await waitFor(M.page, no => { const a = H.app(no); return a && a.status === '접수' && a.device === '1'; }, nos[0])));
  ok('운영자 기록이 마스터 활동 로그에', !!(await waitFor(M.page, no => H.logs().some(t => t === `${no} 접수`), nos[0])));

  // 6. 마스터 DELAY → 운영자 반영 (지연 전파 계산까지)
  const before = await O.page.evaluate(no => { const s = sessionOf(no); return s ? s.x.e : null; }, nos[0]);
  await M.page.evaluate(no => setApp(no, { delay: 10 }, 'QA', `${no} DELAY 10분`), nos[0]);
  const after = await waitFor(O.page, a => { const s = sessionOf(a.no); return s && s.x.e === a.before + 10 ? s.x.e : null; }, { no: nos[0], before });
  ok('마스터 DELAY → 운영자 일정 +10분', !!after, `${before} → ${after}`);

  // 7. 동시 수정: 같은 지원자의 다른 칸
  await Promise.all([
    M.page.evaluate(no => setApp(no, { note: '마스터메모' }), nos[1]),
    O.page.evaluate(no => setApp(no, { status: '연락중' }), nos[1]),
  ]);
  const merged = await waitFor(M.page, no => { const a = H.app(no); return a && a.note === '마스터메모' && a.status === '연락중'; }, nos[1], 20000);
  const merged2 = await waitFor(O.page, no => { const a = H.app(no); return a && a.note === '마스터메모' && a.status === '연락중'; }, nos[1], 20000);
  ok('동시 수정 병합(양쪽 모두 두 칸 유지)', !!merged && !!merged2);

  // 8. 항목 삭제(null) 전파
  await M.page.evaluate(no => setApp(no, { note: null }), nos[1]);
  ok('칸 삭제(null) 전파', !!(await waitFor(O.page, no => { const a = H.app(no); return a && !('note' in a) && a.status === '연락중'; }, nos[1])));

  // 9. 오프라인 대기열 → 재연결 후 전송
  await O.ctx.setOffline(true);
  await O.page.evaluate(no => setApp(no, { inR: true }, 'x', `${no} 입실 체크`), nos[2]);
  const offState = await waitFor(O.page, () => STORE.pending > 0 && SYNC.state === 'error' ? { p: STORE.pending, s: SYNC.state } : null, null, 10000);
  ok('오프라인: 대기열 보관 + 연결 끊김 표시', !!offState, JSON.stringify(offState));
  const persisted = await O.page.evaluate(() => (JSON.parse(localStorage.getItem(STORE_KEY + ':outbox:' + STORE.auth.me.userId) || '[]')).length);
  ok('대기열을 기기에 보관(localStorage)', persisted > 0, `${persisted}건`);
  await O.ctx.setOffline(false);
  await O.page.evaluate(() => window.dispatchEvent(new Event('online')));
  ok('재연결 후 자동 전송 → 마스터 반영', !!(await waitFor(M.page, no => { const a = H.app(no); return a && a.inR === true; }, nos[2], 25000)));
  ok('재연결 후 대기 0건', !!(await waitFor(O.page, () => STORE.pending === 0 && SYNC.state !== 'error')));

  // 10. 행동 강령 체크/해제 + 추가 항목
  const cid = await O.page.evaluate(() => { const c = conductList()[0]; dbSet('conduct/' + c.id, { done: true, at: '10:01', by: '테스트운영' }); return c.id; });
  ok('행동 강령 체크 → 마스터', !!(await waitFor(M.page, id => { const c = H.conduct(id); return c && c.done; }, cid)));
  await M.page.evaluate(id => dbSet('conduct/' + id, null), cid);
  ok('행동 강령 해제 → 운영자', !!(await waitFor(O.page, id => !H.conduct(id), cid)));
  await M.page.evaluate(() => dbSet('extra/xqa1', { t: '11:00', txt: '다과 준비', who: '상주' }));
  ok('추가 행동 강령 → 운영자', !!(await waitFor(O.page, () => { const e = H.extra('xqa1'); return e && e.txt === '다과 준비'; })));

  // 10-1. 칸별 최신값 우선: 오프라인에서 먼저 고친 값이 나중에 온라인에서 고친 값을 덮어쓰지 않아요
  await O.ctx.setOffline(true);
  await O.page.evaluate(no => setApp(no, { status: '불참', note: '오프라인메모' }), nos[4]);
  await new Promise(r => setTimeout(r, 1200));
  await M.page.evaluate(no => setApp(no, { status: '접수' }), nos[4]);
  await waitFor(M.page, () => STORE.pending === 0, null, 15000);
  await O.ctx.setOffline(false);
  await O.page.evaluate(() => window.dispatchEvent(new Event('online')));
  const lww = await waitFor(M.page, no => { const a = H.app(no); return a && a.note === '오프라인메모' ? a : null; }, nos[4], 25000);
  ok('늦게 접속한 오프라인 기록이 최신 값을 덮어쓰지 않음(상태=접수 유지, 다른 칸은 반영)', !!lww && lww.status === '접수', JSON.stringify(lww && { status: lww.status, note: lww.note }));
  ok('운영자 화면도 최신 값으로 맞춰짐', !!(await waitFor(O.page, no => { const a = H.app(no); return a && a.status === '접수'; }, nos[4], 20000)));

  // 10-2. 전자기기 번호: 두 기기가 동시에 배정받아도 겹치지 않아요
  const [d1, d2] = await Promise.all([
    M.page.evaluate(no => STORE.assignDevice(no), nos[5]),
    O.page.evaluate(no => STORE.assignDevice(no), nos[6]),
  ]);
  ok('동시 전자기기 배정 → 서로 다른 번호', !!d1 && !!d2 && d1 !== d2, `${d1} / ${d2}`);
  const d1again = await O.page.evaluate(no => STORE.assignDevice(no), nos[5]);
  ok('이미 번호가 있으면 같은 번호', d1again === d1, `${d1again}`);

  // 10-3. 활동 로그 작성자는 서버가 기록
  await O.page.evaluate(() => addLog('가짜이름 · 마스터', '작성자위조시험'));
  const whoSeen = await waitFor(M.page, () => { const l = logList().find(x => x.txt === '작성자위조시험'); return l && l.who !== '가짜이름 · 마스터' ? l.who : null; }, null, 20000);
  ok('로그 작성자 위조 불가(서버가 계정 이름으로 기록)', whoSeen === '테스트운영 · 운영관리자', String(whoSeen));

  // 10-3b. 같은 계정을 두 번째 탭에서 열면: 그 탭은 가려지고 기록이 막혀요 (전송 대기열 덮어쓰기 방지)
  //        → '이 탭에서 계속 쓰기'로 가져오면 앞 탭이 가려지고 → 그 탭을 닫으면 앞 탭이 자동으로 이어받아요
  const O2 = await O.ctx.newPage();
  O2.on('pageerror', e => errors.push(`operator2: ${e.message}`));
  await O2.goto(O.page.url());
  const b2 = await O2.evaluate(async () => { window.NOTICES = []; STORE.onNotice = m => NOTICES.push(m); const r = await STORE.boot(); await new Promise(r => setTimeout(r, 300)); return { authed: r.authed, blocked: STORE.blocked }; });
  ok('두 번째 탭: 로그인 상태는 이어지지만 기록 차단', b2.authed && b2.blocked === true, JSON.stringify(b2));
  const b2w = await O2.evaluate(no => { const r = setApp(no, { note: '두번째탭' }); return { r, pending: STORE.pending, local: !!((DB.apps || {})[no] && DB.apps[no].note === '두번째탭'), overlay: !!document.getElementById('onsite-blocked'), label: syncLabel()[0] }; }, nos[8]);
  ok('두 번째 탭: 가림 화면 · 입력 거부(화면에도 안 남음) · 상태 표시', b2w.r === false && b2w.pending === 0 && !b2w.local && b2w.overlay && /다른 탭/.test(b2w.label), JSON.stringify(b2w));
  ok('첫 번째 탭은 계속 정상', await O.page.evaluate(() => !STORE.blocked && !document.getElementById('onsite-blocked') && ['poll', 'live'].includes(SYNC.state)));
  await O2.click('[data-onsite-takeover]');
  const tk2 = await waitFor(O2, () => !STORE.blocked && !document.getElementById('onsite-blocked'), null, 10000);
  const tk1 = await waitFor(O.page, () => STORE.blocked && !!document.getElementById('onsite-blocked'), null, 10000);
  ok("'이 탭에서 계속 쓰기' → 두 번째 탭이 기록 · 첫 번째 탭은 가려짐", !!tk2 && !!tk1, JSON.stringify({ tk2, tk1 }));
  const w2 = await O2.evaluate(no => setApp(no, { note: '가져온탭' }), nos[8]);
  ok('가져온 탭의 기록이 서버로', w2 === true && !!(await waitFor(M.page, no => H.app(no) && H.app(no).note === '가져온탭', nos[8], 20000)));
  await O2.close();
  ok('두 번째 탭을 닫으면 첫 번째 탭이 자동으로 이어받음', !!(await waitFor(O.page, () => !STORE.blocked && !document.getElementById('onsite-blocked'), null, 10000)));
  const w1 = await O.page.evaluate(no => setApp(no, { note: '다시첫탭' }), nos[8]);
  ok('이어받은 첫 번째 탭의 기록이 서버로', w1 === true && !!(await waitFor(M.page, no => H.app(no) && H.app(no).note === '다시첫탭', nos[8], 20000)));

  // 10-3c. 인터넷 표시는 켜져 있어도 서버에 닿지 않으면 '연결 끊김'으로 보여요 (빈 전송이 '연결됨'으로 되돌리지 않게)
  await O.page.route('**/rest/v1/rpc/sync_pull*', r => r.abort());
  await O.page.evaluate(() => STORE.pull(true));
  await new Promise(r => setTimeout(r, 2000));
  const st1 = await O.page.evaluate(() => ({ s: SYNC.state, l: syncLabel()[0] }));
  ok('서버에 닿지 않으면 연결 끊김 표시 유지', st1.s === 'error', JSON.stringify(st1));
  await O.page.unroute('**/rest/v1/rpc/sync_pull*');
  await O.page.evaluate(() => STORE.pull(true));
  ok('다시 닿으면 연결됨으로', !!(await waitFor(O.page, () => ['poll', 'live'].includes(SYNC.state), null, 10000)));
  ok('최근 접속 시각 기록(마스터에서 보임)', !!(await waitFor(M.page, id => { const o = opList().find(x => x.id === id); return o && o.lastAt && (STORE.srvNow() - Date.parse(o.lastAt)) < 6 * 60000; }, opId, 15000)));

  // 10-4. 초기화 전에 쌓인 미전송 기록은 초기화 뒤에 되살아나지 않아요
  await O.ctx.setOffline(true);
  await O.page.evaluate(no => setApp(no, { note: '초기화전기록' }), nos[7]);
  const rs0 = await M.page.evaluate(() => dbReset());
  ok('(준비) 마스터 초기화', rs0 && rs0.ok);
  await O.ctx.setOffline(false);
  await O.page.evaluate(() => { window.NOTICES = []; STORE.onNotice = m => NOTICES.push(m); window.dispatchEvent(new Event('online')); });
  const dropped = await waitFor(O.page, () => (window.NOTICES || []).find(m => /초기화 전/.test(m)) || null, null, 25000);
  ok('초기화 전 미전송 기록 버림 + 안내', !!dropped, String(dropped));
  await new Promise(r => setTimeout(r, 4000));
  ok('서버에 초기화 전 기록이 남지 않음', await M.page.evaluate(async no => { const r = await STORE.sb.from('apps').select('data').eq('event_code', CONFIG.code).eq('no', no).maybeSingle(); return !r.data || !r.data.data || !r.data.data.note; }, nos[7]));

  // 11. 운영자는 마스터 전용 동작 불가
  const deny = await O.page.evaluate(() => STORE.admin.resetEvent());
  ok('운영자의 초기화 시도 거부', !deny.ok, deny.error || '');
  const denyRoster = await O.page.evaluate(async () => { const r = await STORE.sb.from('roster').update({ file: 'hack' }).eq('event_code', CONFIG.code).select(); return { err: r.error && r.error.message, n: (r.data || []).length }; });
  ok('운영자의 시간표 수정 거부(RLS)', denyRoster.n === 0, JSON.stringify(denyRoster));
  const opLogs = await O.page.evaluate(async () => { const r = await STORE.sb.from('op_secrets').select('*'); return (r.data || []).length; });
  ok('운영자는 임시 비밀번호 목록을 못 봄', opLogs === 0);

  // 12. 초기화 → 양쪽 현장 기록 비움, 시간표 유지
  const rs = await M.page.evaluate(() => dbReset());
  ok('마스터 초기화(reset_event)', rs && rs.ok, rs && rs.message || '');
  ok('초기화 후 운영자 기록 비움 + 시간표 유지', !!(await waitFor(O.page, a => !H.app(a.no) && !H.extra('xqa1') && J.ready && J.roster.length === a.n, { no: nos[0], n: nos.length }, 20000)));
  ok('초기화 후 마스터 로그 비움(초기화 기록 외)', !!(await waitFor(M.page, no => !H.logs().some(t => t === `${no} 접수`), nos[0], 20000)));

  // 13. 역할 변경 → 운영자 본인 정보 갱신
  const sr = await M.page.evaluate(id => STORE.admin.setRole(id, '인솔'), opId);
  ok('역할 변경', sr.ok && !!(await waitFor(O.page, () => STORE.auth.me && STORE.auth.me.role === '인솔')));

  // 14. 사용 중지 → 운영자 강제 로그아웃
  const sd = await M.page.evaluate(id => STORE.admin.setDisabled(id, true), opId);
  ok('사용 중지(set_disabled)', sd.ok, sd.message || '');
  const kicked = await waitFor(O.page, () => window.KICKED.length ? window.KICKED[0] : null, null, 20000);
  ok('사용 중지 → 운영자 강제 로그아웃', !!kicked, kicked || '');
  ok('로그아웃 후 기기 캐시 삭제', await O.page.evaluate(() => !localStorage.getItem(STORE_KEY) || JSON.parse(localStorage.getItem(STORE_KEY)).roster === null));
  const relog = await O.page.evaluate(async a => STORE.auth.signIn(a.id, a.pw), { id: opId, pw: NEWPW });
  ok('사용 중지 계정 로그인 거부', !relog.ok, relog.message || '');
} catch (e) {
  ok('예외 없이 완료', false, e.stack || String(e));
} finally {
  // 정리: 운영자 삭제, 시간표 비우기
  try {
    if (opId) { const d = await M.page.evaluate(id => STORE.admin.deleteOp(id), opId); ok('정리: 운영자 삭제', d.ok, d.message || ''); }
    await M.page.evaluate(() => { dbSet('roster', null); return dbReset(); });
    await waitFor(M.page, () => STORE.pending === 0, null, 15000);
    await M.page.evaluate(() => STORE.auth.signOut());
  } catch (e) { console.log('정리 중 오류', e.message); }
  ok('페이지 오류 없음', errors.length === 0, errors.join(' | '));
  await browser.close(); await srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
