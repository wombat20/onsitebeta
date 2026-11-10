# ONSITE BETA

채용 면접 현장 운영 도구(베타). 마스터 관리자(PC)와 운영관리자(휴대폰)가 같은 데이터를 실시간으로 보며 접수·입퇴실·지연·행동 강령을 기록해요.

| 화면 | 주소 |
|---|---|
| 마스터 관리자 (PC) | https://wombat20.github.io/onsitebeta/beta-master.html |
| 운영관리자 (휴대폰) | https://wombat20.github.io/onsitebeta/beta-operator.html |

운영 방법(첫 로그인, 운영자 초대, 당일 점검표, 문제 해결, 행사 후 삭제)은 **[docs/RUNBOOK.md](docs/RUNBOOK.md)** 에 있어요.

## 동작 방식

- **온라인 모드(기본)**: Supabase(서울 리전)에 저장해요. 로그인한 행사 멤버만 데이터를 볼 수 있어요(RLS). 입력은 화면에 먼저 반영되고, 연결이 끊기면 기기에 보관했다가 자동으로 다시 보내요. 변경은 Realtime 신호와 주기 확인(Realtime이 막히면 3초)으로 받아요.
- **로컬 모드(비상용)**: 주소 뒤에 `?local=1`. 이 브라우저에만 저장하고, 운영자에게는 시간표 링크로 시간표만 보내요.
- **같은 계정은 한 기기에서 탭 하나만** 기록해요. 다른 탭은 화면이 가려지고, 앞 탭을 닫으면 자동으로 이어받아요.
- 마스터의 **운영자 초대** 화면에서 운영자마다 비밀번호 설정 여부와 **● 접속 중**(최근 몇 분 안에 화면을 켠 기기)을 볼 수 있어요.

## 파일

| 경로 | 내용 |
|---|---|
| `beta-master.html` | 마스터 관리자 화면 |
| `beta-operator.html` | 운영관리자 화면 |
| `beta-master (2).html` | 예전 주소 → `beta-master.html` 로 이동 |
| `js/onsite-engine.js` | 공통 엔진: 설정(CONFIG), 시간표 엑셀 읽기, 지연 전파 계산, 행동 강령 |
| `js/onsite-store.js` | 화면이 쓰는 데이터 저장 계층(로컬 모드 + 온라인 연결부) |
| `js/onsite-sb.js` | 온라인 모드: 로그인, 전송 대기열, 동기화, 계정 관리 호출 |
| `vendor/` | supabase-js 2.118.0, SheetJS 0.18.5 (고정 버전, CDN 없이 동작) |
| `supabase/` | DB 마이그레이션, 서버 함수 `admin-ops`, 권한 테스트 · [supabase/README.md](supabase/README.md) |
| `tests/` | 자동 테스트 · [tests/README.md](tests/README.md) |

코드에 들어 있는 Supabase 주소와 `sb_publishable_` 키는 공개용이에요. 관리자 키와 비밀번호는 저장소에 없어요.
