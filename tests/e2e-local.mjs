/* 로컬 모드 E2E (Playwright · headless chromium)
   - 저장소를 127.0.0.1:8080 (E2E_PORT) 으로 서빙
   - 컨텍스트 A: 마스터(1440×900) + 운영자(390×844) · 같은 브라우저라 storage 이벤트로 실시간 연동
   - 컨텍스트 B: 다른 휴대폰(iPhone 13 화면 · deviceScaleFactor 1) · 마스터의 '운영자에게 시간표 보내기' 링크로 시간표 받기
   실행: node tests/e2e-local.mjs   (스크린숏: ONSITE_SHOTS · 기본 스크래치패드 shots/) */
import fs from 'node:fs';
import path from 'node:path';
import { REPO, FIXTURES, SHOTS_DIR, loadPlaywright } from './lib/env.mjs';
import { startServer } from './lib/serve.mjs';
import { blockExternal } from './lib/golden-compute.mjs';

const PORT = +(process.env.E2E_PORT || 8080);
const { chromium, devices } = loadPlaywright();
fs.mkdirSync(SHOTS_DIR, { recursive: true });

let srv;
try { srv = await startServer([{ prefix: '/', dir: REPO }], PORT); }
catch (e) { console.log(`포트 ${PORT} 사용 중 · 빈 포트로 열어요`); srv = await startServer([{ prefix: '/', dir: REPO }], 0); }
const BASE = srv.url;
const Q = '?local=1&t=10:00';
const browser = await chromium.launch();

const errors = [];
const IGNORE = /Failed to load resource|net::ERR_|fonts\/|pretendard|WantedSans/i;
function watch(page, tag) {
  page.on('pageerror', e => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(`[${tag}] console: ${m.text()}`); });
  return page;
}
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { const note = await fn(); results.push(['ok', name, note]); console.log(`  ok   ${name}${note ? ' · ' + note : ''} (${Date.now() - t0}ms)`); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log(`  FAIL ${name}\n       ${String(e.stack || e).split('\n').slice(0, 4).join('\n       ')}`); throw e; }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: false });
const until = (page, fn, arg, ms = 5000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });

let exitCode = 0;
try {
  /* ---------- 컨텍스트 A ---------- */
  const ctxA = await browser.newContext({ deviceScaleFactor: 1 });
  await blockExternal(ctxA);
  const master = watch(await ctxA.newPage(), 'master');
  await master.setViewportSize({ width: 1440, height: 900 });
  const op = watch(await ctxA.newPage(), 'operatorA');
  await op.setViewportSize({ width: 390, height: 844 });

  await step('마스터: 로컬 모드로 로그인 없이 열림', async () => {
    await master.goto(`${BASE}/beta-master.html${Q}`);
    await master.locator('#nav .nav-item').first().waitFor();
    const st = await master.evaluate(() => ({ mode: STORE.mode, app: STORE.app, auth: S.auth, me: ME.name, sync: syncLabel()[0], login: !!document.querySelector('#lg-id') }));
    assert(st.mode === 'local' && st.app === 'master' && st.auth === true && !st.login, JSON.stringify(st));
    assert(await master.getByText('아직 시간표가 없어요').count() > 0, '시간표 없음 안내가 없어요');
    return `${st.me} · ${st.sync}`;
  });

  await step('운영자 A: 로그인 없이 열림 · 시간표 없음 안내', async () => {
    await op.goto(`${BASE}/beta-operator.html${Q}`);
    await op.locator('#tabbar .tab').first().waitFor();
    const st = await op.evaluate(() => ({ mode: STORE.mode, app: STORE.app, auth: S.auth, login: !!document.querySelector('#lg-id') }));
    assert(st.mode === 'local' && st.app === 'operator' && st.auth && st.auth.id === 'local' && !st.login, JSON.stringify(st));
    for (const t of ['board', 'list', 'conduct']) {
      await op.click(`#tabbar [data-t="${t}"]`);
      assert(await op.getByText('아직 시간표가 없어요').count() === 1, `${t} 탭에 빈 화면 안내가 없어요`);
      assert(await op.getByText('채용 담당자가 시간표를 올리면 자동으로 나타나요').count() === 1, `${t} 탭 안내 문구`);
    }
    await op.click('#tabbar [data-t="my"]');
    const my = await op.locator('#main').innerText();
    assert(!my.includes('로그아웃') && !my.includes('비밀번호') && my.includes('로컬 모드'), '마이: 로그아웃/비밀번호 숨김 · 로컬 모드 표시');
    assert(!my.includes('면접 장소'), 'CONFIG.place 가 비면 면접 장소 숨김');
    assert(my.includes('한국소방산업기술원'), '마이: 기관 표시');
    await shot(op, 'operator-empty.png');
  });

  await step('마스터: 깨진 시간표(면접시작 열 없음) → 오류 모달', async () => {
    for (const f of ['timetable-broken.xlsx', 'timetable-broken.csv']) {
      await master.setInputFiles('#fileIn', path.join(FIXTURES, f));
      await master.locator('.modal .mh b', { hasText: '확인이 필요해요' }).waitFor({ timeout: 8000 });
      const body = await master.locator('.modal').innerText();
      assert(body.includes('머리글 행을 찾지 못했어요'), `${f}: 오류 문구 없음 · ${body.slice(0, 200)}`);
      assert(await master.locator('.modal [data-act="applyTT"]').count() === 0, '오류인데 적용 버튼이 있어요');
      if (f.endsWith('.xlsx')) await shot(master, 'master-broken-modal.png');
      await master.click('.modal .mf [data-act="closeModal"]');
    }
    assert(await master.evaluate(() => J.ready) === false, '깨진 파일로 시간표가 바뀌었어요');
  });

  await step('마스터: 시간표 엑셀 업로드 → 미리보기 → 적용 · 운영보드 표시', async () => {
    await master.setInputFiles('#fileIn', path.join(FIXTURES, 'timetable.xlsx'));
    await master.locator('.modal .mh b', { hasText: '시간표 미리보기' }).waitFor({ timeout: 8000 });
    const pv = await master.locator('.modal').innerText();
    assert(pv.includes('21') && pv.includes('3면접실'), '미리보기 내용 · ' + pv.slice(0, 200));
    assert(pv.includes('연락처 없는 지원자 1명'), '경고 문구(연락처 없음)');
    await master.click('.modal [data-act="applyTT"]');
    await master.locator('.modal').waitFor({ state: 'detached' });
    await master.click('[data-act="monRoom"][data-i="all"]');
    const rows = await master.locator('table.board tbody select[data-app$=":status"]').count();
    assert(rows === 21, `보드 지원자 행 ${rows}`);
    const gap = await master.locator('table.board tr.block').count();
    assert(gap === 1, `빈 시간 행 ${gap}`);
    const loaded = await master.evaluate(() => [...document.scripts].some(s => /vendor\/xlsx-0\.18\.5/.test(s.src)));
    assert(loaded, 'vendor xlsx 사본으로 읽지 않았어요');
    return `행 ${rows} · 빈 시간 ${gap}`;
  });

  await step('운영자 A: 시간표가 자동으로 나타남 (storage 이벤트) · 명단 21명', async () => {
    await op.click('#tabbar [data-t="list"]');
    await until(op, () => document.querySelectorAll('.prow').length === 21);
    const head = await op.locator('.listhead').innerText();
    assert(head.includes('21명'), 'listhead ' + head);
    assert(await op.locator('.block.gap').count() === 1, '운영자 명단의 빈 시간 행');
    const gapTxt = await op.locator('.block.gap').innerText();
    assert(gapTxt.includes('12:00') && gapTxt.includes('13:00'), 'gap ' + gapTxt);
    await op.click('#tabbar [data-t="board"]');
    const rooms = await op.locator('.bd-room').count();
    assert(rooms === 3, `면접실 카드 ${rooms}`);
    const nx = await op.locator('.bd-nx').count();
    assert(nx === 3, `다음 입실 ${nx}`);
    await shot(op, 'operator-board.png');
    return `면접실 ${rooms} · 다음 입실 ${nx}`;
  });

  await step('운영자 A: 접수 → 전자기기 자동 번호 · 마스터 보드 반영', async () => {
    await op.click('#tabbar [data-t="list"]');
    await op.click('.prow[data-no="T01-0004"]');
    await op.locator('.sheet .inum', { hasText: 'B2-1' }).waitFor();
    await op.click('.sheet [data-act="setSt"][data-v="접수"]');
    await op.locator('.toast', { hasText: '전자기기 1번' }).waitFor();
    assert(await op.evaluate(() => A('T01-0004').device) === '1', '기기 번호');
    await until(master, () => { const s = document.querySelector('select[data-app="T01-0004:status"]'); const d = document.querySelector('input[data-app="T01-0004:device"]'); return s && s.value === '접수' && d && d.value === '1'; });
    /* 두 번째 접수는 2번 */
    await op.click('.sheet [data-act="closeSheet"]');
    await op.click('.prow[data-no="T02-0004"]');
    await op.click('.sheet [data-act="setSt"][data-v="접수"]');
    await op.locator('.toast', { hasText: '전자기기 2번' }).waitFor();
    await op.click('.sheet [data-act="closeSheet"]');
    await until(master, () => document.querySelector('input[data-app="T02-0004:device"]')?.value === '2');
    const kpi = await master.locator('.kpi').first().innerText();
    assert(/2\s*\/\s*21/.test(kpi.replace(/\n/g, ' ')), 'KPI ' + kpi);
    return 'T01-0004 → 1번 · T02-0004 → 2번';
  });

  await step('마스터: DELAY 10 → 운영자 화면 일정 밀림', async () => {
    const inp = master.locator('input[data-app="T01-0001:delay"]');
    await inp.fill('10');
    await inp.press('Tab');
    await until(master, () => A('T01-0001').delay === 10);
    /* B1 10:00–10:25 +10 → B2 10:30 → 10:40 시작 (+10) */
    await until(op, () => [...document.querySelectorAll('.sess')].some(s => /B2조/.test(s.textContent) && /10:40/.test(s.querySelector('.tm').textContent) && /\+10/.test(s.querySelector('.tm').textContent)));
    const roomDelay = await op.evaluate(() => roomDelay(J.sched.rooms[0]));
    assert(roomDelay === 10, 'roomDelay ' + roomDelay);
    return 'B2조 10:40 (+10)';
  });

  await step('운영자 A: 불참 → 조 면접시간 단축 · 마스터 반영', async () => {
    await op.click('.prow[data-no="T01-0005"]');
    await op.click('.sheet [data-act="setSt"][data-v="불참"]');
    await op.locator('#dlg [data-act="doAbsent"]').click();
    await op.locator('.toast', { hasText: '25분 → 17분' }).waitFor();
    await op.click('.sheet [data-act="closeSheet"]');
    const sess = await op.locator('.sess', { hasText: 'B2조' }).innerText();
    assert(sess.includes('2/3명') && sess.includes('17분') && sess.includes('재산정'), 'B2 세션 ' + sess.replace(/\n/g, ' '));
    await until(master, () => document.querySelector('select[data-app="T01-0005:status"]')?.value === '불참');
    const len = await master.evaluate(() => sessionOf('T01-0005').x.len);
    assert(len === 17, 'master len ' + len);
    await shot(op, 'operator-list.png');
    return 'B2조 25분 → 17분';
  });

  await step('행동 강령 체크 동기화 (운영자 ↔ 마스터)', async () => {
    await op.click('#tabbar [data-t="conduct"]');
    const chips = await op.locator('.chips [data-act="cdf"]').allInnerTexts();
    assert(chips.join(',') === '전체,접수,인솔,상주', '필터 ' + chips.join(','));
    const id = await op.locator('.tchk[data-act="cd"]').first().getAttribute('data-id');
    await op.locator('.tchk[data-act="cd"]').first().click();
    await until(master, i => conductList().find(c => c.id === i)?.done === true && !!document.querySelector(`input[data-act="conductToggle"][data-id="${i}"]:checked`), id);
    /* 반대 방향: 마스터에서 체크 → 운영자 */
    const id2 = await master.evaluate(i => conductList().find(c => !c.done && c.id !== i).id, id);
    await master.locator(`input[data-act="conductToggle"][data-id="${id2}"]`).click();
    await until(op, i => !!document.querySelector(`.tchk.on[data-id="${i}"]`) || conductList().find(c => c.id === i)?.done === true, id2);
    await op.click('.chips [data-act="cdf"][data-k="상주"]');
    return `${id} · ${id2}`;
  });

  await step('운영자 A: DELAY 스테퍼 · 입실/퇴실 토글 · 비고 · 알림 · 테스트 시각', async () => {
    await op.click('#tabbar [data-t="list"]');
    await op.click('.prow[data-no="T02-0001"]');
    await op.click('.sheet [data-act="dly"][data-d="5"]');
    await op.locator('.toast', { hasText: 'A1-1 지연 5분' }).waitFor();
    await op.click('.sheet [data-act="dly"][data-d="-1"]');
    assert(await op.evaluate(() => A('T02-0001').delay) === 4, 'delay 4');
    await op.click('.sheet [data-act="tgl"][data-k="inR"]');
    await op.click('.sheet [data-act="tgl"][data-k="outR"]');
    const note = op.locator('.sheet input[data-f="note"]');
    await note.fill('테스트 메모');
    await note.press('Tab');
    await until(op, () => A('T02-0001').note === '테스트 메모');
    await op.click('.sheet [data-act="closeSheet"]');
    await until(master, () => A('T02-0001').inR && A('T02-0001').outR && A('T02-0001').delay === 4 && A('T02-0001').note === '테스트 메모');
    await master.click('[data-act="monRoom"][data-i="1"]');
    await until(master, () => document.querySelector('input[data-appchk="T02-0001:inR"]')?.checked === true && document.querySelector('input[data-app="T02-0001:delay"]')?.value === '4');
    await op.click('#tabbar [data-t="board"]');
    await op.click('[data-act="noti"]');
    await op.locator('.sheet .sh-title', { hasText: '알림' }).waitFor();
    await op.click('.sheet [data-act="tab"][data-t="conduct"]');
    /* 테스트 시각 바는 PC 폭에서만 보여요 (휴대폰 폭에서는 숨김) */
    await op.setViewportSize({ width: 1280, height: 900 });
    await op.click('#demo [data-act="clock"][data-d="10"]');
    assert((await op.locator('#demo').innerText()).includes('10:10'), '테스트 시각 +10');
    await op.click('#demo [data-act="clock"][data-d="-10"]');
    await op.setViewportSize({ width: 390, height: 844 });
    await master.click('[data-act="monRoom"][data-i="all"]');
    return 'A1-1 DELAY 4 · 입실·퇴실 · 비고';
  });

  await step('마스터: 운영자 초대(로컬 모드 안내) · 베타 관리(로그아웃·비밀번호 숨김)', async () => {
    await master.click('#nav [data-p="people"]');
    const ppl = await master.locator('#view').innerText();
    assert(ppl.includes('온라인 모드') && ppl.includes('운영자에게 시간표 보내기'), '초대 페이지 · ' + ppl.slice(0, 200));
    assert(await master.locator('#view table, [data-oprole], [data-act="opInvite"], [data-act="opReset"]').count() === 0, '로컬 모드에서 계정 표·버튼 숨김');
    assert(await master.locator('[data-act="opAdd"]').count() === 0, '로컬 모드에서 초대 버튼 숨김');
    await master.click('#nav [data-p="admin"]');
    const adm = await master.locator('#view').innerText();
    assert(adm.includes('로컬 모드') && !adm.includes('로그아웃') && !adm.includes('비밀번호 변경') && !adm.includes('SYNC'), '베타 관리 · ' + adm.slice(0, 300));
    assert(await master.locator('[data-act="boardCsv"]').count() === 1 && await master.locator('[data-act="reset"]').count() === 1, '내보내기·초기화 버튼');
    const dl = master.waitForEvent('download');
    await master.click('[data-act="boardCsv"]');
    const d = await dl; const csv = fs.readFileSync(await d.path(), 'utf8');
    assert(csv.split('\n').length === 22 && csv.includes('T01-0005') && csv.includes('불참'), '현장 기록 CSV');
    await shot(master, 'master-admin.png');
    return `CSV ${csv.split('\n').length - 1}행`;
  });

  let link = '';
  await step('마스터: 운영자에게 시간표 보내기 링크', async () => {
    await master.click('#nav [data-p="sched"]');
    await master.click('[data-act="ttShare"]');
    await master.locator('.modal .mh b', { hasText: '운영자에게 시간표 보내기' }).waitFor();
    link = await master.evaluate(() => window._share && window._share.link);
    assert(link && /beta-operator\.html(\?local=1)?#tt=[zu][\w-]+$/.test(link), 'link ' + String(link).slice(0, 120));
    await master.click('.modal [data-act="closeModal"]');
    await master.click('#nav [data-p="monitor"]');
    await master.click('[data-act="monRoom"][data-i="all"]');
    await shot(master, 'master-monitor.png');
    return `${link.length.toLocaleString()}자`;
  });

  /* ---------- 컨텍스트 B: 다른 휴대폰 ---------- */
  await step('운영자 B(다른 기기): 링크로 시간표 받기', async () => {
    const ctxB = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
    await blockExternal(ctxB);
    const opB = watch(await ctxB.newPage(), 'operatorB');
    await opB.goto(link);
    await opB.locator('.toast', { hasText: '최신 시간표를 받았어요' }).waitFor({ timeout: 8000 });
    assert(!(await opB.evaluate(() => location.hash)), '주소의 # 이 지워지지 않았어요');
    await opB.click('#tabbar [data-t="list"]');
    const n = await opB.locator('.prow').count();
    assert(n === 21, `B 명단 ${n}`);
    /* 다른 기기는 기록이 공유되지 않아요(로컬 모드) · 시간표만 */
    const st = await opB.evaluate(() => ({ s: A('T01-0004').status, by: DB.roster.by, k: STORE_KEY }));
    assert(st.s === '' && st.by === '시간표 링크', JSON.stringify(st));
    await shot(opB, 'operatorB-from-link.png');
    /* 잘못된 링크 */
    await opB.evaluate(() => { location.hash = 'tt=zBROKEN'; });
    await opB.locator('.toast.red', { hasText: '시간표 링크가 올바르지 않아요' }).waitFor({ timeout: 5000 });
    assert(await opB.locator('.prow').count() === 21, '잘못된 링크 후에도 기존 시간표 유지');
    await ctxB.close();
    return `명단 ${n}명`;
  });

  await step('마스터: 한글 검색(IME 조합) 깨지지 않음 · 검색창에 커서가 있어도 현장 현황 갱신', async () => {
    await master.click('#nav [data-p="monitor"]');
    await master.click('[data-inp="monQ"]');
    const cdp = await ctxA.newCDPSession(master);
    for (const t of ['ㅇ', '오']) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await master.waitForTimeout(60); }
    await cdp.send('Input.insertText', { text: '오' });
    await master.waitForTimeout(150);
    const s1 = await master.evaluate(() => ({ v: document.querySelector('[data-inp="monQ"]').value, q: S.monQ,
      rows: [...document.querySelectorAll('#mon-body tr')].filter(tr => tr.querySelector('[data-app$=":status"]')).length,
      want: J.roster.filter(r => (r.name + r.no + INO(r.no)).includes('오')).length }));
    assert(s1.v === '오' && s1.q === '오' && s1.rows === s1.want && s1.want === 2, '한글 검색: ' + JSON.stringify(s1));
    /* 검색창에 커서가 있는 동안 운영자 기록이 들어와도 표가 바로 바뀌어야 해요 */
    const no = await master.evaluate(() => J.roster.find(r => r.name.includes('오')).no);
    await op.evaluate(n => setApp(n, { status: '연락중' }, '운영자 · 운영관리자', 'IME 테스트'), no);
    await until(master, n => { const el = document.querySelector(`[data-app="${n}:status"]`); return el && el.value === '연락중'; }, no, 5000);
    const s2 = await master.evaluate(() => ({ focus: document.activeElement && document.activeElement.dataset.inp, v: document.querySelector('[data-inp="monQ"]').value }));
    assert(s2.focus === 'monQ' && s2.v === '오', '갱신 뒤 검색창 유지: ' + JSON.stringify(s2));
    await op.evaluate(n => setApp(n, { status: '' }, '운영자 · 운영관리자', 'IME 테스트 복구'), no);
    await master.fill('[data-inp="monQ"]', '');
    await master.locator('body').click({ position: { x: 5, y: 5 } });
    return `검색 '오' → ${s1.rows}명 · 커서 유지한 채 갱신`;
  });

  await step('운영자: 검색창에 커서가 있어도 명단 갱신 · 검색창·입력값 유지 (휴대폰 키보드가 닫히지 않게)', async () => {
    await op.click('#tabbar [data-t="list"]');
    await op.click('[data-inp="q"]');
    await op.keyboard.type('T01-000');
    await until(op, () => document.querySelectorAll('#list-body .prow').length === 9);
    await op.evaluate(() => { window.__q = document.querySelector('[data-inp="q"]'); });
    await master.evaluate(() => setApp('T01-0007', { status: '연락중' }, '로컬 관리자 · 마스터', '검색 갱신 테스트'));
    await until(op, () => { const r = document.querySelector('#list-body .prow[data-no="T01-0007"]'); return r && /연락중/.test(r.textContent); });
    const s = await op.evaluate(() => ({ same: document.querySelector('[data-inp="q"]') === window.__q, focus: document.activeElement === window.__q, v: window.__q.value, n: document.querySelectorAll('#list-body .prow').length }));
    assert(s.same && s.focus && s.v === 'T01-000' && s.n === 9, JSON.stringify(s));
    await master.evaluate(() => setApp('T01-0007', { status: '' }, '로컬 관리자 · 마스터', '검색 갱신 테스트 복구'));
    await op.fill('[data-inp="q"]', '');
    await op.click('#tabbar [data-t="board"]');
    return '검색창 그대로 · 명단만 갱신';
  });

  await step('기능: 운영자 명단 시작–종료 표시 · 성별 체크(운영자 ↔ 마스터 · CSV) · 미도착 행동 강령(집결 5분 전·정각 알림 · 접수하면 빠짐)', async () => {
    /* 1) 운영자 명단: 조 머리에 시작–종료 */
    await op.click('#tabbar [data-t="list"]');
    const tmRaw = await op.evaluate(() => [...document.querySelectorAll('#list-body .sess-h .tm')].map(e => e.textContent));
    const tm = tmRaw.slice(0, 4).map(t => t.replace(/[+-]\d+(?=–)/, ''));
    /* 지연(+n)은 시작 시각 바로 뒤에 붙어요 (종료가 밀린 것처럼 읽히지 않게) */
    assert(tmRaw.some(t => /^\d\d:\d\d\+\d+–\d\d:\d\d$/.test(t)), '지연 표시 위치: ' + JSON.stringify(tmRaw));
    assert(tm.length >= 3 && tm.every(t => /^\d\d:\d\d–\d\d:\d\d/.test(t)), '시작–종료: ' + JSON.stringify(tm));
    /* 2) 성별: 운영자 상세에서 '여' → 마스터 표 · 다시 누르면 지움 · 마스터에서 '남' → 운영자 */
    const NO = 'T01-0009';
    await op.click(`.prow[data-no="${NO}"]`);
    await op.click(`.sheet [data-act="sex"][data-v="여"]`);
    await until(master, n => A(n).sex === '여' && document.querySelector(`select[data-app="${n}:sex"]`)?.value === '여', NO);
    assert(await op.evaluate(n => /여/.test(document.querySelector(`.prow[data-no="${n}"] .l2`)?.textContent || ''), NO), '운영자 명단에 성별 표시');
    await op.click(`.sheet [data-act="sex"][data-v="여"]`);
    await until(master, n => A(n).sex === '' && !(DB.apps[n] || {}).sex, NO);
    await master.selectOption(`select[data-app="${NO}:sex"]`, '남');
    await until(op, n => A(n).sex === '남' && !!document.querySelector(`.sheet [data-act="sex"][data-v="남"].on`), NO);
    await op.click('.sheet [data-act="closeSheet"]');
    const dl = master.waitForEvent('download');
    await master.click('#nav [data-p="admin"]'); await master.click('[data-act="boardCsv"]');
    const csv = fs.readFileSync(await (await dl).path(), 'utf8');
    const head = csv.replace(/^\uFEFF/, '').split('\n')[0].split(','); const row = csv.split('\n').find(l => l.includes(NO)).split(',');
    assert(head.includes('성별') && row[head.indexOf('성별')] === '남', 'CSV 성별: ' + head.join('|'));
    await master.click('#nav [data-p="monitor"]');
    /* 3) 미도착 확인: B2조(집결 09:50) · 09:44 에는 없고 09:45 부터 · 접수·불참이 아닌 사람만 */
    const m = await master.evaluate(() => {
      const slot = L => L.filter(c => c.kind === 'miss' && c.txt.includes('B2조'));
      const want = J.roster.filter(r => r.grp === 'B2' && !['접수', '불참'].includes(A(r.no).status)).map(r => r.no);
      return { before: slot(conductList(T('09:44'))).length, at: slot(conductList(T('09:45'))).map(c => ({ t: c.t, who: c.who, nos: c.nos, txt: c.txt })), want,
        a5: conductAlert(T('09:45'), true), a0: conductAlert(T('09:50'), true), a1: conductAlert(T('09:46'), true),
        /* 09:15 · 1면접실 B1조와 2면접실 A2조가 같은 09:20 집결 → 한 알림에 둘 다 */
        both: conductAlert(T('09:15'), true) };
    });
    assert(m.want.length > 0 && m.before === 0 && m.at.length === 1 && m.at[0].t === '09:50' && m.at[0].who === '접수' && JSON.stringify(m.at[0].nos) === JSON.stringify(m.want), '미도착 항목: ' + JSON.stringify(m));
    assert(m.a5 && m.a5.red && /^5분 후 집결 마감 · .*B2조 미도착/.test(m.a5.msg) && m.a0 && /^집결 마감 · .*B2조 미도착/.test(m.a0.msg) && !m.a1, '알림: ' + JSON.stringify([m.a5, m.a0, m.a1]));
    assert(m.both && m.both.n === 2 && /B1조 미도착/.test(m.both.msg) && /A2조 미도착/.test(m.both.msg), '같은 분 알림 모음: ' + JSON.stringify(m.both));
    /* 운영자: 미도착과 일반 행동 강령이 같은 분이면 둘 다 (10:05 · C-1 미도착 5분 전 + C-1 인성검사 안내 10분 전) */
    const mix = await op.evaluate(() => conductAlert(T('10:05')));
    assert(mix && mix.n >= 2 && /미도착/.test(mix.msg) && /10분 후 · /.test(mix.msg), '미도착+일반 알림: ' + JSON.stringify(mix));
    /* 지금(테스트 시각 10:00)은 집결이 지난 미도착 → 미완료로 보여요 · 운영자 화면 행동 강령에도 */
    assert(await master.evaluate(() => lateConduct(nowMin()).some(c => c.kind === 'miss' && c.txt.includes('B2조'))), '마감 지난 미도착은 미완료');
    await op.click('#tabbar [data-t="conduct"]');
    await op.click('.chips [data-act="cdf"][data-k="접수"]');   // 담당 '접수' 필터에서도 보여요
    assert(await op.locator('.titem', { hasText: 'B2조 미도착' }).count() === 1, '운영자 행동 강령에 미도착 항목');
    await op.click('.chips [data-act="cdf"][data-k="전체"]');
    /* 모두 접수하면 항목이 사라져요 */
    await op.evaluate(L => { L.forEach(n => setApp(n, { status: '접수' }, '운영자 · 운영관리자', '미도착 테스트')); render(true); }, m.want);   // 화면 버튼과 같이 기록 뒤 다시 그려요
    await until(master, () => !conductList().some(c => c.kind === 'miss' && c.txt.includes('B2조')));
    await until(op, () => !document.querySelector('.titem') || ![...document.querySelectorAll('.titem')].some(e => /B2조 미도착/.test(e.textContent)));
    await op.evaluate(L => L.forEach(n => setApp(n, { status: '' }, '운영자 · 운영관리자', '미도착 테스트 복구')), m.want);
    await op.click('#tabbar [data-t="board"]');
    return `시작–종료 ${tm[0]} · 성별 남/여 · B2조 미도착 ${m.want.length}명`;
  });

  await step('마스터: 한글 엑셀 CSV(CP949)도 읽힘', async () => {
    const tmp = path.join(SHOTS_DIR, 'timetable-cp949.csv');
    const { execFileSync } = await import('node:child_process');
    const utf8 = fs.readFileSync(path.join(FIXTURES, 'timetable.csv'), 'utf8').replace(/^\uFEFF/, '');
    fs.writeFileSync(tmp, execFileSync('python3', ['-I', '-c', 'import sys;sys.stdout.buffer.write(sys.stdin.read().encode("cp949"))'], { input: utf8 }));
    await master.click('#nav [data-p="sched"]');
    await master.setInputFiles('#fileIn', tmp);
    await master.locator('.modal [data-act="applyTT"]').waitFor({ timeout: 5000 });
    const n = await master.evaluate(() => PENDING && PENDING.res.rows.length);
    await master.click('.modal [data-act="closeModal"]');
    assert(n === 21, 'CP949 CSV 행 수 ' + n);
    return `${n}명`;
  });

  await step('마스터: 초기화 → 기록만 지움 (시간표 유지) · 운영자 반영', async () => {
    await master.click('#nav [data-p="admin"]');
    await master.click('[data-act="reset"]');
    /* 확인란에 '초기화'를 입력해야 실행돼요 (서버 백업이 없어 실수로 누르지 않게) */
    await master.click('.modal [data-act="doReset"]');
    await master.locator('.toast.red', { hasText: "확인란에 '초기화'" }).waitFor({ timeout: 3000 });
    assert(await master.evaluate(() => A('T01-0005').status !== '' || logList().length > 1), '확인 입력 없이 초기화됨');
    await master.fill('#rs-c', '초기화');
    await master.click('.modal [data-act="doReset"]');
    await master.locator('.toast', { hasText: '초기화 완료' }).waitFor();
    const m = await master.evaluate(() => ({ ready: J.ready, n: R().length, st: A('T01-0005').status, logs: logList().length }));
    assert(m.ready && m.n === 21 && m.st === '' && m.logs === 1, JSON.stringify(m));
    await until(op, () => A('T01-0005').status === '' && J.ready);
    return JSON.stringify(m);
  });

  await step('예전 주소 beta-master (2).html → beta-master.html 로 이동 (쿼리·해시 유지)', async () => {
    const ctx = await browser.newContext();
    await blockExternal(ctx);
    const pg = watch(await ctx.newPage(), 'redirect');
    await pg.goto(`${BASE}/beta-master%20(2).html?local=1&t=10:00#x`);
    await pg.waitForURL(/\/beta-master\.html\?local=1&t=10:00#x$/, { timeout: 5000 });
    await pg.locator('#nav .nav-item').first().waitFor();
    await ctx.close();
    return 'ok';
  });

  await step('SB_URL 을 채운 경우(온라인 모드 모듈 없이): 로그인 화면 · 오류 없음 · ?local=1 은 로컬 모드', async () => {
    const ctx = await browser.newContext({ deviceScaleFactor: 1 });
    await blockExternal(ctx);
    const engine = fs.readFileSync(path.join(REPO, 'js', 'onsite-engine.js'), 'utf8');
    assert(/SB_URL:'[^']*',/.test(engine), 'CONFIG.SB_URL 을 찾지 못했어요');
    /* 온라인 모드 모듈(onsite-sb.js·supabase)은 막아 두고, 화면이 그것 없이도 깨지지 않는지만 봐요 */
    await ctx.route(/\/js\/onsite-engine\.js/, r => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: engine.replace(/SB_URL:'[^']*',/, "SB_URL:'https://sb.invalid',") }));
    await ctx.route(/\/(js\/onsite-sb|vendor\/supabase)[^/]*\.js/, r => r.abort());
    const m = watch(await ctx.newPage(), 'sb-master');
    await m.goto(`${BASE}/beta-master.html?t=10:00`);
    await m.locator('#lg-id').waitFor();
    const ms = await m.evaluate(() => ({ mode: STORE.mode, key: STORE_KEY, sync: syncLabel()[0], auth: S.auth }));
    assert(ms.mode === 'sb' && ms.key.endsWith(':master') && ms.key.startsWith('onsitebeta:v2:sb:') && ms.sync === '연결 중' && ms.auth === false, JSON.stringify(ms));
    const o = watch(await ctx.newPage(), 'sb-operator');
    await o.goto(`${BASE}/beta-operator.html?t=10:00#tt=zIGNORED`);
    await o.locator('#lg-id').waitFor();
    const os = await o.evaluate(() => ({ mode: STORE.mode, key: STORE_KEY, auth: S.auth, hash: location.hash, ready: J.ready }));
    assert(os.mode === 'sb' && os.key.endsWith(':operator') && !os.auth && !os.hash && !os.ready, JSON.stringify(os));
    /* ?local=1 이면 SB_URL 이 있어도 로컬 · 시간표 링크에도 local=1 */
    const l = watch(await ctx.newPage(), 'sb-local');
    await l.goto(`${BASE}/beta-master.html?local=1&t=10:00`);
    await l.locator('#nav .nav-item').first().waitFor();
    await l.setInputFiles('#fileIn', path.join(FIXTURES, 'timetable.csv'));
    await l.locator('.modal [data-act="applyTT"]').click();
    await l.click('#nav [data-p="sched"]');
    await l.click('[data-act="ttShare"]');
    await l.locator('.modal .mh b', { hasText: '운영자에게 시간표 보내기' }).waitFor();
    const lk = await l.evaluate(() => window._share.link);
    assert(/beta-operator\.html\?local=1#tt=/.test(lk), 'local link ' + lk.slice(0, 80));
    await ctx.close();
    return `${ms.key} · ${os.key}`;
  });

  await step('콘솔·페이지 오류 없음 (CDN 글꼴 로드 실패는 제외)', async () => { assert(errors.length === 0, '콘솔/페이지 오류:\n  ' + errors.join('\n  ')); });
} catch (e) {
  exitCode = 1;
  if (errors.length) console.log('  page/console errors:\n    ' + errors.join('\n    '));
} finally {
  await browser.close();
  await srv.close();
}
const okN = results.filter(r => r[0] === 'ok').length;
console.log(`\nE2E: ${okN} 통과 · ${results.length - okN} 실패 · 스크린숏 ${SHOTS_DIR}`);
process.exit(exitCode);
