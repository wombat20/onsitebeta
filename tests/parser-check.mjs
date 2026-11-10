/* 시간표 파서 점검 (node · 브라우저 없이)
   - 조구분이 빈 칸인 조원(셀 병합 → CSV 저장)이 바로 위 사람의 조로 들어가는지
   - 같은 면접실에서 면접 시간이 겹치면 경고하는지
   - 정상 양식에는 경고를 내지 않는지
   실행: node tests/parser-check.mjs */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { REPO, FIXTURES } from './lib/env.mjs';

const ctx = vm.createContext({ console, URLSearchParams, TextEncoder, TextDecoder,
  location: { search: '', hash: '', pathname: '/beta-master.html', href: 'http://x/beta-master.html' },
  window: {}, navigator: { userAgent: 'node' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { addEventListener() {}, querySelector: () => null } });
vm.runInContext(fs.readFileSync(path.join(REPO, 'js', 'onsite-engine.js'), 'utf8') + '\n;globalThis.__E={parseTimetable,parseCSV,buildJ:typeof buildJ==="function"?buildJ:null};', ctx);
const { parseTimetable, parseCSV } = ctx.__E;

let fail = 0;
const ok = (name, cond, note) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${note ? ' · ' + note : ''}`); if (!cond) fail++; };
const H = ['수험번호', '면접실', '일차', '조구분', '면접번호', '집결', '준비실 이동', '준비 시작', '면접실 이동', '면접시작', '면접종료', '이름', '모집분야', '연락처', '비상연락처'];
const row = (no, room, grp, ino, s, e, name) => [no, room, '1일차', grp, ino, '', '', '', '', s, e, name, '분야', '010-0000-0000', ''];

// 1) 정상 양식(테스트 fixture) → 겹침·조구분 경고 없음
const fx = parseTimetable(parseCSV(fs.readFileSync(path.join(FIXTURES, 'timetable.csv'), 'utf8').replace(/^﻿/, '')));
ok('fixture: 21명 · 오류 없음', fx.rows.length === 21 && !fx.errors.length, `${fx.rows.length}명 · ${fx.errors.join(' / ')}`);
ok('fixture: 겹침·조구분 경고 없음', !fx.warns.some(w => /겹쳐요|조구분이 빈 칸/.test(w)), fx.warns.join(' / '));

// 2) 조구분 빈 칸(병합 셀을 CSV로 저장) → 바로 위 조로 들어감
const t2 = [H, row('B01-00001', '1면접실', 'B1', 'B1-1', '10:00', '10:25', '홍길동'), row('B01-00002', '', '', 'B1-2', '10:00', '10:25', '김예시'),
  row('B01-00004', '', '', 'B1-3', '10:00', '10:25', '최예시'), row('B01-00003', '', 'B2', 'B2-1', '10:30', '10:55', '이샘플')];
const r2 = parseTimetable(t2);
ok('빈 조구분 → 바로 위 조(B1)로', r2.rows.filter(r => r.grp === 'B1').length === 3, r2.rows.map(r => r.no + ':' + r.grp).join(' '));
ok('빈 조구분 채움 안내', r2.warns.some(w => /조구분이 빈 칸인 2명/.test(w)), r2.warns.join(' / '));
ok('채운 뒤 겹침 경고 없음', !r2.warns.some(w => /겹쳐요/.test(w)), r2.warns.join(' / '));

// 3) 시각이 다르면 빈 조구분을 채우지 않음 (개인 면접)
const t3 = [H, row('C01', '3면접실', 'B1', 'B1-1', '10:00', '10:25', '가'), row('C02', '', '', 'C-1', '10:30', '10:50', '나')];
const r3 = parseTimetable(t3);
ok('시각이 다르면 개인 면접 그대로', r3.rows[1].grp === '' && !r3.warns.some(w => /조구분이 빈 칸/.test(w)), r3.rows.map(r => r.no + ':' + r.grp).join(' '));

// 4) 같은 면접실에서 다른 면접이 겹침 → 경고
const t4 = [H, row('D01', '2면접실', 'A1', 'A1-1', '10:00', '10:30', '가'), row('D02', '', 'A2', 'A2-1', '10:20', '10:50', '나'), row('D03', '', '-', 'P-1', '11:00', '11:20', '다')];
const r4 = parseTimetable(t4);
ok('겹치는 면접 경고', r4.warns.some(w => /겹쳐요 1건/.test(w) && /10:00–10:30/.test(w)), r4.warns.join(' / '));

// 5) 다른 면접실끼리는 같은 시각이어도 경고 없음
const t5 = [H, row('E01', '1면접실', 'A1', 'A1-1', '10:00', '10:30', '가'), row('E02', '2면접실', 'A1', 'A1-1', '10:00', '10:30', '나')];
ok('다른 면접실은 겹침 아님', !parseTimetable(t5).warns.some(w => /겹쳐요/.test(w)));

console.log(fail ? `\n파서 점검 실패 ${fail}건` : '\n파서 점검 통과');
process.exit(fail ? 1 : 0);
