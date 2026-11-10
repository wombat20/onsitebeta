/* 합성(가짜) 면접 시간표 픽스처 생성기 · 실제 인물 정보는 절대 넣지 않아요
   실행: node tests/fixtures/make-fixtures.mjs
   만드는 파일 (이 폴더):
   - timetable.xlsx / timetable.csv          정상 시간표 (3개 면접실 · 21명)
   - timetable-broken.xlsx / timetable-broken.csv   면접시작 열이 빠진 시간표 (오류 처리 테스트)
   구성
   - 1면접실: 조별 면접 B1·B2·B3 (각 3명 · 25분)
   - 2면접실: 조별 면접 A1·A2 (각 3명 · 25분)
   - 3면접실: 개인 면접 (조구분 '-') · 12:00–13:00 점심으로 60분 빈 시간 → 'gap' 행
   - 머리글에 면접실별 단계 이름: '준비실 이동\n(3면접실: 인성검사 안내)'
   - xlsx 는 면접실 열을 면접실 단위로 병합(이어지는 행은 빈칸) · 시각은 엑셀 시각값 · 1행은 제목
   - csv 는 'HH:MM' 문자열 · 면접실 열은 첫 행에만 · 1행은 제목
   - 연락처 없는 지원자 1명 (3면접실 C-3) · 집결 시각이 빈 지원자 1명 (C-6 · 기본값 시작 40분 전) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadXLSX } from '../lib/env.mjs';

const X = loadXLSX();
const OUT = path.dirname(fileURLToPath(import.meta.url));
const pad = n => String(n).padStart(2, '0');
const T = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const HM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);

const HEAD = ['수험번호', '면접실', '일차', '조구분', '면접번호', '집결', '준비실 이동\n(3면접실: 인성검사 안내)', '준비 시작\n(3면접실: 인성검사 시작)',
  '면접실 이동', '면접시작', '면접종료', '이름', '모집분야', '연락처', '비상연락처'];
const TIME_COLS = new Set([5, 6, 7, 8, 9, 10]);
const NUM = ['일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십', '십일', '십이', '십삼', '십사', '십오', '십육', '십칠', '십팔', '십구', '이십', '이십일'];
const F1 = '테스트경쟁_일반직 6급_소방설비(기계)', F2 = '테스트경쟁_일반직 6급_소방설비(전기)', F3 = '테스트제한경쟁_연구직_소방기술 연구';

let k = 0;
const person = () => { const i = k++; return { name: '테스트' + NUM[i], phone: '010-0000-00' + pad(i + 1) }; };
function rows() {
  k = 0;
  const out = []; /* 각 원소: {room, first, cells[15]} */
  const group = (room, prefix, grp, start, len, n, field, roomFirst) => {
    for (let j = 0; j < n; j++) {
      const p = person(); const s = T(start);
      out.push({ room, first: roomFirst && j === 0, cells: [
        `${prefix}-${pad(out.filter(r => r.room === room).length + 1).padStart(4, '0')}`, room, roomFirst && j === 0 ? '1일차' : '', grp, `${grp}-${j + 1}`,
        HM(s - 40), HM(s - 30), HM(s - 20), HM(s - 5), HM(s), HM(s + len), p.name, field, p.phone, j === 0 ? '010-0000-10' + pad(k) : ''] });
      roomFirst = false;
    }
  };
  const solo = (room, prefix, ino, start, len, field, roomFirst, opt = {}) => {
    const p = person(); const s = T(start);
    out.push({ room, first: roomFirst, cells: [
      `${prefix}-${pad(out.filter(r => r.room === room).length + 1).padStart(4, '0')}`, room, roomFirst ? '1일차' : '', '-', ino,
      opt.noArrive ? '' : HM(s - 30), HM(s - 25), HM(s - 20), HM(s - 5), HM(s), HM(s + len), p.name, field, opt.noPhone ? '' : p.phone, ''] });
  };
  group('1면접실', 'T01', 'B1', '10:00', 25, 3, F1, true);
  group('1면접실', 'T01', 'B2', '10:30', 25, 3, F1, false);
  group('1면접실', 'T01', 'B3', '11:00', 25, 3, F2, false);
  group('2면접실', 'T02', 'A1', '09:30', 25, 3, F2, true);
  group('2면접실', 'T02', 'A2', '10:00', 25, 3, F1, false);
  solo('3면접실', 'T03', 'C-1', '10:40', 20, F3, true);
  solo('3면접실', 'T03', 'C-2', '11:00', 20, F3, false);
  solo('3면접실', 'T03', 'C-3', '11:20', 20, F3, false, { noPhone: true });
  solo('3면접실', 'T03', 'C-4', '11:40', 20, F3, false);
  solo('3면접실', 'T03', 'C-5', '13:00', 20, F3, false);
  solo('3면접실', 'T03', 'C-6', '13:20', 20, F3, false, { noArrive: true });
  return out;
}

const TITLE = '테스트 면접시간표 (합성 데이터 · 실제 인물 아님)';

function writeXlsx(file, dropCol) {
  const R = rows();
  const keep = HEAD.map((_, i) => i).filter(i => i !== dropCol);
  const ws = {};
  const enc = (r, c) => X.utils.encode_cell({ r, c });
  ws[enc(0, 0)] = { t: 's', v: TITLE };
  keep.forEach((ci, c) => { ws[enc(1, c)] = { t: 's', v: HEAD[ci] }; });
  R.forEach((row, i) => {
    keep.forEach((ci, c) => {
      const v = row.cells[ci];
      if (ci === 1 && !row.first) return; /* 병합된 면접실 칸: 이어지는 행은 비움 */
      if (v === '') return;
      ws[enc(i + 2, c)] = TIME_COLS.has(ci) ? { t: 'n', v: T(v) / 1440, z: 'hh:mm' } : { t: 's', v };
    });
  });
  /* 면접실 열 병합 (면접실 단위) + 제목 행 병합 */
  const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: keep.length - 1 } }];
  const roomCol = keep.indexOf(1);
  if (roomCol >= 0) {
    let s = 0;
    for (let i = 1; i <= R.length; i++) {
      if (i === R.length || R[i].room !== R[s].room) { if (i - 1 > s) merges.push({ s: { r: s + 2, c: roomCol }, e: { r: i - 1 + 2, c: roomCol } }); s = i; }
    }
  }
  ws['!merges'] = merges;
  ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R.length + 1, c: keep.length - 1 } });
  ws['!cols'] = keep.map(ci => ({ wch: [10, 9, 7, 7, 9, 7, 14, 14, 10, 9, 9, 10, 34, 15, 15][ci] }));
  const guide = X.utils.aoa_to_sheet([['작성 안내'], ['이 파일은 테스트용 합성 데이터예요 · 실제 지원자 정보가 아니에요'], ['2행이 머리글이에요']]);
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '면접시간표');
  X.utils.book_append_sheet(wb, guide, '작성 안내');
  wb.Props = { Title: 'ONSITE 테스트 시간표', Author: 'onsitebeta tests', CreatedDate: new Date('2026-01-01T00:00:00Z') };
  fs.writeFileSync(path.join(OUT, file), X.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

function writeCsv(file, dropCol) {
  const R = rows();
  const keep = HEAD.map((_, i) => i).filter(i => i !== dropCol);
  const cell = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const lines = [[TITLE].concat(keep.slice(1).map(() => '')), keep.map(ci => HEAD[ci])]
    .concat(R.map(row => keep.map(ci => (ci === 1 && !row.first) ? '' : row.cells[ci])));
  fs.writeFileSync(path.join(OUT, file), '﻿' + lines.map(l => l.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');
}

const START_COL = HEAD.indexOf('면접시작');
writeXlsx('timetable.xlsx', -1);
writeCsv('timetable.csv', -1);
writeXlsx('timetable-broken.xlsx', START_COL);
writeCsv('timetable-broken.csv', START_COL);
console.log(`fixtures: ${rows().length}명 · ${['timetable.xlsx', 'timetable.csv', 'timetable-broken.xlsx', 'timetable-broken.csv'].join(', ')}`);
