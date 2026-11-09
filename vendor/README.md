# vendor/

CDN(cdnjs·jsdelivr)에 의존하지 않도록 같은 저장소에서 서빙하는 외부 라이브러리 사본이에요. 파일 이름에 버전을 넣어, 바꿀 때는 새 파일을 추가하고 참조를 옮겨 주세요.

| 파일 | 패키지 | 버전 | 출처 | 라이선스 |
|---|---|---|---|---|
| `supabase-2.118.0.js` | `@supabase/supabase-js` | 2.118.0 | npm · `dist/umd/supabase.js` (전역 `supabase`) | MIT |
| `xlsx-0.18.5.full.min.js` | `xlsx` (SheetJS Community Edition) | 0.18.5 | npm · `dist/xlsx.full.min.js` (전역 `XLSX`) | Apache-2.0 |

- 수정하지 않은 원본 그대로예요 (sha256 아래 참고).
- `beta-master.html` 의 `loadXLSX()` 는 `vendor/xlsx-0.18.5.full.min.js` 를 먼저 불러오고, 실패하면 cdnjs 주소로 다시 시도해요.

```
ee3be8de192b97cb1d73d1e95d6b82bb1f6b658c0f97c4ef757fc331996ed3d3  supabase-2.118.0.js
c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99  xlsx-0.18.5.full.min.js
```

다시 받는 방법:

```sh
npm pack @supabase/supabase-js@2.118.0 xlsx@0.18.5   # 또는 npm i 후 node_modules 에서 복사
```
