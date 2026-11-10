# tests/

저장소에는 `package.json` 이 없어요. 테스트는 Node 22 와 미리 설치된 npm 패키지를 그대로 써요.

| 무엇 | 경로 | 바꾸는 방법 |
|---|---|---|
| npm 패키지 (`xlsx`, `playwright-core` 등) | 스크래치패드 `npm/node_modules` | 환경변수 `ONSITE_NPM_DIR` |
| Playwright | 전역 `playwright` (`npm root -g`) → 없으면 `ONSITE_NPM_DIR/playwright-core` | `npm i -g playwright` |
| 원본 마스터 v2 사본 (기준값용) | 스크래치패드 `golden/master-v2-orig.html` | `ONSITE_GOLDEN_SRC` |
| 스크린숏 | 스크래치패드 `shots/` | `ONSITE_SHOTS` |
| E2E 포트 | `127.0.0.1:8080` (사용 중이면 빈 포트) | `E2E_PORT` |

기본 경로는 `tests/lib/env.mjs` 맨 위에 있어요. 정적 파일 서버는 `tests/lib/serve.mjs`(Node 내장 http · 127.0.0.1 전용)를 써서 `http-server` 없이도 돌아가요.
외부 CDN(cdnjs·jsdelivr 글꼴)은 테스트에서 막아 두고, 그 로드 실패는 오류로 치지 않아요.

## 한 번에

```sh
node tests/run-local.mjs        # static-check → parser-check → golden-check → e2e-local
```

## 하나씩

```sh
node tests/static-check.mjs     # node --check (js/*.js · 인라인 <script>) · 금지어 · 비밀값 검사
node tests/parser-check.mjs     # 시간표 파서: 빈 조구분(셀 병합 → CSV) 채우기 · 같은 면접실 시간 겹침 경고
node tests/golden-check.mjs     # 새 엔진 계산 == tests/golden/golden.json (마스터·운영자 둘 다)
node tests/e2e-local.mjs        # 로컬 모드 화면 흐름 (마스터 ↔ 운영자 · 시간표 링크)
```

### static-check.mjs
- `js/*.js` 와 `beta-master.html` · `beta-operator.html` 의 인라인 스크립트를 꺼내 `node --check`
- `ONSITE_APP → js/onsite-engine.js → js/onsite-store.js` 순서 확인
- 금지어 0건: `initPw` `Onsite2026` `SYNC_URL` `EventSource` `mkRoster` `PLAN0` `sh0(` `timeline(J` `.ino` `J.place` `blocks/`
- 저장소 전체(`.git`·`vendor` 제외)에 service_role·sb_secret·JWT 형태 값이 없는지

### golden.mjs / golden-check.mjs
- `golden.mjs` 는 **리팩터링 전** 원본(`beta-master (2).html` v2, 커밋 `9e87d19`)으로 기준값을 만들어요.
  원본 사본이 없으면: `git show 9e87d19:"beta-master (2).html" > <ONSITE_GOLDEN_SRC>`
- 계산 내용(`tests/lib/golden-compute.mjs`): 픽스처 CSV·XLSX 파싱 결과(행·오류·경고·단계 이름), 깨진 픽스처 오류,
  `J.sched.rooms`, 면접실별 `timeline(room,false/true)`·`roomDelay`·`stepAt`·`stepLabel`, `conductList`·`lateConduct`·`soonConduct`,
  지원자별 `INO`·`sessionOf`, 시간표 링크 토큰 왕복, 그리고 DELAY 10(1면접실 B1-1)·불참(B2-2) 뒤의 `timeline`·`roomDelay`·`DB.apps`.
- `golden-check.mjs` 는 같은 계산을 새 `beta-master.html?local=1&t=10:00`(xlsx 는 `loadXLSX()` → vendor 사본)과
  `beta-operator.html?local=1&t=10:00` 에서 하고 깊은 비교해요. 하나라도 다르면 실패.
- 엔진 계산을 **일부러** 바꿨다면 차이를 검토한 뒤, `ONSITE_GOLDEN_SRC` 를 새 기준 마스터 파일로 지정해 `golden.mjs` 를 다시 돌리고 golden.json 변경을 함께 커밋하세요.

### e2e-local.mjs (headless chromium)
컨텍스트 A(같은 브라우저): 마스터 1440×900 + 운영자 390×844 · 컨텍스트 B: 다른 휴대폰(iPhone 13 화면, deviceScaleFactor 1)
1. 마스터·운영자 로컬 모드로 로그인 없이 열림 · 운영자 빈 화면 안내(운영보드·명단·행동 강령) · 마이(로그아웃·비밀번호 숨김)
2. 깨진 픽스처(xlsx·csv) → '확인이 필요해요' 오류 모달
3. `#fileIn` 으로 `timetable.xlsx` 업로드 → 미리보기 → 적용 → 보드 21행 + 빈 시간 1행 (vendor xlsx 사용 확인)
4. 운영자 화면에 자동 반영(storage 이벤트) · 명단 21명 · 빈 시간 행
5. 운영자 접수 → 전자기기 1번·2번 자동 · 마스터 보드 반영
6. 마스터 DELAY 10 → 운영자 B2조 10:40(+10)
7. 운영자 불참 → B2조 25분 → 17분 · 마스터 반영
8. 행동 강령 체크 양방향 동기화 · 필터 전체/접수/인솔/상주
9. 운영자 DELAY 스테퍼·입실/퇴실·비고·알림·테스트 시각 → 마스터 반영
10. 마스터 운영자 초대(로컬 안내)·베타 관리(로그아웃·비밀번호 숨김) · 현장 기록 CSV
11. 마스터 '운영자에게 시간표 보내기' 링크 → 컨텍스트 B 에서 열면 시간표 21명 · 주소의 `#` 제거 · 잘못된 링크 안내
- 추가: 마스터 한글 검색(IME 조합을 CDP 로 흉내) · 검색창에 커서가 있어도 현장 현황 갱신 · 운영자 검색 중 명단만 갱신(검색창 유지) · 한글 엑셀 CSV(CP949) 읽기 · 초기화는 확인란에 '초기화' 입력해야 실행
12. 마스터 초기화 → 기록만 지우고 시간표 유지 · 운영자 반영
13. `beta-master (2).html` → `beta-master.html` 이동(쿼리·해시 유지)
14. `CONFIG.SB_URL` 을 채운 경우(온라인 모듈 없이): 로그인 화면·앱별 저장 키·`#tt=` 무시 · `?local=1` 이면 로컬 + 링크에 `local=1`
15. 콘솔·페이지 오류 0건

스크린숏: `master-monitor.png` `master-admin.png` `master-broken-modal.png` `operator-empty.png` `operator-board.png` `operator-list.png` `operatorB-from-link.png`

## 픽스처

```sh
node tests/fixtures/make-fixtures.mjs
```
합성 데이터만 써요(이름 `테스트일`… · 연락처 `010-0000-00xx`). 같은 입력이면 같은 파일이 나와요(결정적).
- `timetable.xlsx` / `timetable.csv`: 1면접실 B1·B2·B3(3명·25분), 2면접실 A1·A2, 3면접실 개인 면접 6명(12:00–13:00 빈 시간),
  머리글 `준비실 이동\n(3면접실: 인성검사 안내)`, xlsx 면접실 열 병합, 1행 제목, 연락처 없는 지원자 1명, 집결 빈칸 1명
- `timetable-broken.*`: 면접시작 열 없음

## 온라인 모드 (실제 Supabase · TEST 행사)

실제 서버의 **TEST 행사**만 써요(실제 행사 KFI26 데이터와 분리). QA 마스터 계정은 저장소 밖 `ONSITE_SCRATCH/secrets/qa.json` 에서 읽어요. 이 파일이 없으면 실행할 수 없어요.

```sh
node tests/e2e-sb-store.mjs     # 저장 계층만: 로그인·계정 생성·첫 비밀번호 변경·양방향 동기화·동시 수정 병합·오프라인 재전송·다른 탭 가림/이어받기·서버 불통 표시·초기화·사용 중지 (55개)
node tests/e2e-sb-ui.mjs        # 실제 화면: 마스터 PC + 운영자 휴대폰(iPhone 13) 전체 흐름 · 접속 중 표시 · 사용 중지 확인창 (38개)
node supabase/tests/api_e2e.mjs # 서버 API 직접 호출 (74개) · SECRETS_DIR 필요
```

- 화면 테스트는 `?ev=TEST` 로 테스트 행사에 연결해요.
- 로그인 시도 제한(같은 IP 5분 30회 수준)이 있어서 연달아 여러 번 돌리면 잠시 실패할 수 있어요.
- 권한 매트릭스: `supabase/tests/rls_matrix.sql` 을 SQL Editor(또는 MCP execute_sql)에서 실행 · 항상 ROLLBACK 돼요.

- Node 의 fetch 가 프록시를 거쳐야 하는 환경이면 `NODE_USE_ENV_PROXY=1` 을 붙여 실행해요.

> TEST 행사와 QA 마스터는 아직 서버에 있어요. 화면·저장 계층 테스트는 끝나면 운영자 계정과 기록을 스스로 지우고, `api_e2e.mjs` 는 TEST 운영자 하나(`TEST-S01`)를 남겨요. 행사가 끝난 뒤 `supabase/README.md` 의 SQL 로 지우세요. 지운 뒤 다시 돌리려면 admin-ops `bootstrap` 으로 다시 만들어야 해요.
