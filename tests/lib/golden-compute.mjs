/* golden.mjs(원본 기준값 생성)와 golden-check.mjs(리팩터링 후 비교)가 함께 쓰는 계산
   페이지 안에서 엔진 함수(parseCSV, parseTimetable, sheetTable, dbSet, timeline, sessions, roomDelay, conductList …)를 직접 불러요.
   UI 로그인은 거치지 않아요. */

/* 페이지 안에서 실행되는 함수 · 바깥 변수는 쓰지 않아요 */
async function inPage({ csvUrl, xlsxUrl, brokenCsvUrl, brokenXlsxUrl }) {
  const clone = o => JSON.parse(JSON.stringify(o));
  const X = window.XLSX;
  if (!X) throw new Error('XLSX not loaded');
  const readCsv = async u => parseTimetable(parseCSV((await (await fetch(u)).text()).replace(/^﻿/, '')));
  const readXlsx = async u => {
    const wb = X.read(await (await fetch(u)).arrayBuffer(), { type: 'array' });
    let best = null;
    for (const n of wb.SheetNames) { const t = sheetTable(X, wb.Sheets[n]); const res = parseTimetable(t); if (!best || res.rows.length > best.res.rows.length) best = { res, n }; }
    return { res: best.res, sheet: best.n, sheets: wb.SheetNames };
  };
  const out = {};
  /* 원본 v2 는 불참 시 조 시간을 줄였어요 · 기준값과 같은 계산을 비교하려고 새 엔진도 이 비교 안에서만 켜요
     (실제 기본값 shrinkOnAbsent:false 는 tests/e2e-local.mjs 에서 따로 확인) */
  if (typeof CONFIG !== 'undefined' && 'shrinkOnAbsent' in CONFIG) CONFIG.shrinkOnAbsent = true;
  const csv = await readCsv(csvUrl);
  const xl = await readXlsx(xlsxUrl);
  out.csv = clone(csv);
  out.xlsx = clone(xl.res);
  out.xlsxSheet = xl.sheet;
  out.xlsxSheets = xl.sheets;
  out.csvEqualsXlsx = JSON.stringify(csv) === JSON.stringify(xl.res);
  out.brokenCsv = clone(await readCsv(brokenCsvUrl));
  out.brokenXlsx = clone((await readXlsx(brokenXlsxUrl)).res);
  out.toHM = [toHM(''), toHM(0.5), toHM('9:05'), toHM('오후 1:30'), toHM('12시 05'), toHM('PM 12:10'), toHM('AM 12:10'), toHM('abc')];

  dbSet('roster', { v: 1, file: 'f', labels: xl.res.labels, rows: xl.res.rows });

  const tl = x => Object.assign({}, x, { it: x.it ? x.it.id : undefined });
  const rooms = J.sched.rooms;
  out.J = { ready: J.ready, v: J.v, file: J.file, labels: clone(J.labels), arrive: clone(J.arrive), nos: J.roster.map(r => r.no) };
  out.rooms = clone(rooms);
  out.plan = rooms.map(rm => ({
    name: rm.name,
    tlPlan: clone(timeline(rm, false).map(tl)),
    tlActual: clone(timeline(rm, true).map(tl)),
    roomDelay: roomDelay(rm),
    steps: sessions(rm, true).map(x => ({ id: x.it.id, pm: stepAt(x, 'prepMove'), ps: stepAt(x, 'prepStart'), rm: stepAt(x, 'roomMove') })),
    labels: ['prepMove', 'prepStart', 'roomMove'].map(k => stepLabel(k, rm.name)),
  }));
  /* 미도착 확인(kind 'miss')은 원본 v2 에 없던 자동 항목이라 기준값 비교에서 빼요 (tests/e2e-local.mjs 에서 따로 확인) */
  const base = L => L.filter(c => c.kind !== 'miss');
  out.conduct = base(conductList()).map(c => ({ id: c.id, t: c.t, txt: c.txt, who: c.who, done: c.done }));
  out.now = nowMin();
  out.late600 = base(lateConduct(600)).map(c => c.id);
  out.soonNow = base(soonConduct(nowMin())).map(c => c.id);
  out.lookups = J.roster.map(r => {
    const s = sessionOf(r.no);
    return { no: r.no, ino: INO(r.no), name: P(r.no).name, short: shortField(P(r.no).field), st: stLabel(A(r.no).status), cls: statusCls(A(r.no).status),
      sess: s ? { room: s.room.name, id: s.x.it.id, s: s.x.s, e: s.x.e, label: s.x.label } : null };
  });
  const tok = await rosterToken(DB.roster);
  out.token = { kind: tok[0], back: clone(await rosterFromToken(tok)) };

  /* 변경: 1면접실 첫 조 첫 사람 DELAY 10 · 둘째 조 둘째 사람 불참 */
  const r1 = rooms.find(r => r.name === '1면접실');
  const a = r1.items[0].members[0], b = r1.items[1].members[1];
  setApp(a, { delay: 10 }, 'golden', `${INO(a)} DELAY 10분`);
  setApp(b, { status: '불참', inR: false, device: '' }, 'golden', `${INO(b)} 불참`);
  out.changed = { delayNo: a, absentNo: b };
  out.after = J.sched.rooms.map(rm => ({ name: rm.name, tlActual: clone(timeline(rm, true).map(tl)), roomDelay: roomDelay(rm) }));
  out.afterApps = clone(DB.apps);
  /* 성별(sex)은 원본 v2 이후에 추가한 칸이라 기준값 비교에서 빼요 */
  const noSex = o => { const c = clone(o); if (c) delete c.sex; return c; };
  out.afterJApps = { [a]: noSex(A(a)), [b]: noSex(A(b)) };
  out.afterLogs = logList().map(l => [l.who, l.txt]).sort();
  out.afterSess = [a, b].map(no => { const s = sessionOf(no); return { no, s: s.x.s, e: s.x.e, len: s.x.len, attend: s.x.attend, delay: s.x.delay, shift: s.x.shift }; });
  /* null 패치는 키 삭제 */
  setApp(a, { delay: null });
  out.afterNull = clone(DB.apps[a]);
  out.afterNullDelay = roomDelay(r1);
  return out;
}

export async function computeGolden(page, base) {
  const f = p => `${base}/tests/fixtures/${p}`;
  return page.evaluate(inPage, { csvUrl: f('timetable.csv'), xlsxUrl: f('timetable.xlsx'), brokenCsvUrl: f('timetable-broken.csv'), brokenXlsxUrl: f('timetable-broken.xlsx') });
}

/* 외부(CDN) 요청은 이 샌드박스에서 막혀 있어 기다리지 않도록 바로 끊어요 */
export async function blockExternal(ctxOrPage) {
  await ctxOrPage.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort());
}

/* 깊은 비교 · 다른 경로를 최대 n개 돌려줘요 */
export function diff(a, b, p = '$', out = [], n = 20) {
  if (out.length >= n) return out;
  if (Object.is(a, b)) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') { out.push(`${p}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${p}: array/object mismatch`); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diff(a[k], b[k], `${p}.${k}`, out, n);
  return out;
}
