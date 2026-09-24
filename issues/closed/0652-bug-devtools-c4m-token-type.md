# c4m から取り込んだトークンを Token Type 0 で送っている

- Created: 2026-09-21
- Completed: 2026-09-24
- Branch: feature/fix-devtools-c4m-token-type
- Polished: 2026-09-21

## 目的

MSF URL の c4m から取り込んだ CAT を out-of-band を表す Token Type 0 として送っている。draft-ietf-moq-c4m-01 §7.1 Table 4 は Token Type 0x01 を CAT として登録し、§7.1.1 は 0x01 の Token Payload を CBOR エンコードされた CWT として直列化した CAT と定めている。draft-ietf-moq-transport-21 §8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」ものと定めているため、受信側は c4m のトークンを CAT として扱わない。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は `authorizationTokenBase64` を設定したあと `authorizationTokenType.value = "0"` を設定する。JSDoc にも「Token Type を 0 (out-of-band) に設定する」と書かれている
- `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken` は c4m の Base64 を復号した生バイト列を Token Value に使い、`authorizationTokenType.value` を bigint に変換して `tokenType` に載せる。Alias Type が useValue のときは USE_VALUE、register のときは REGISTER として送る。Token Type が空文字のときは 0n にする
- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` の既定値は `"0"` であり、c4m 以外の手入力経路でも Token Type 0 が既定になる
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` は url / fragment の c4m を反映したあとにクエリパラメータの `authorizationTokenType` を適用するため、c4m と Authorization Token のクエリパラメータを同時に持つ URL では、クエリの値が c4m の取り込み値を上書きする (クエリの値が 0 のときは CAT が Token Type 0 で送られる)。引数を取らず `window.location.search` を読むため、Node のテストからは駆動できない
- `devtools/src/components/ConnectionSettings.tsx` の Token Value の入力は c4m の Base64 トークンを解除するが、Token Type の入力は解除しない
- `devtools/src/signals/connectionSettings.test.ts` は `applyC4mFromUrl` のあとの `authorizationTokenType.value` が `"0"` であることと、`authorizationTokenBase64` を直接設定したときの `tokenType === 0n` を固定している
- `CHANGES.md` の未リリースの `## develop` に、c4m のトークンを「USE_VALUE / Token Type 0 の SETUP トークンとして送る」という記述がある

## 設計方針

- `applyC4mFromUrl` は CAT を表す Token Type `"1"` (0x01) を設定し、JSDoc も 0x01 (CAT) に直す。Alias Type は `USE_VALUE` のままとする (transport-21 §9.1.4 は SETUP で DELETE / USE_ALIAS を受けたら PROTOCOL_VIOLATION と定めている)
- `authorizationTokenType` の既定値は `"0"` のまま据え置く。transport-21 §8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」ものと定め、§16.6 Table 12 は 0x0 を Reserved (仕様は §8.9) として登録している。手入力の Token Value は UTF-8 テキストで CBOR エンコードされた CWT ではないため、既定を 1 にすると c4m-01 §7.1.1 の Payload 定義に反するトークンを送ることになる。既定値と、Token Type が空文字のとき 0n になるフォールバックは変えない
- `initFromUrl` は検索文字列を引数で受ける形にし (`initFromUrl(search: string)`、呼び出しは `main.tsx` が `window.location.search` を渡す。`devtools/src/webtransport-devtools/params.ts` の `parseSettingsQueryString(search)` と同じ形)、c4m の反映を Authorization Token のクエリパラメータより後ろに移す。url → fragment の順に適用し、fragment の c4m を最優先とする。c4m があるときはクエリの Token Type / Token Value を c4m の取り込みで置き換える
- `ConnectionSettings.tsx` の Token Type の入力でも、Token Value と同じく c4m の Base64 トークンを解除する。解除しないと、c4m の取り込み後に Token Type を書き換えても送信内容と UI の表示が食い違う。c4m の表示ブロックに `data-testid="authorization-token-c4m"` を 1 つだけ付け (テキスト一致では C4M ヘルプの文言とも当たる)、テストから一意に観測できるようにする。解除後に URL 欄を編集し直すと再び取り込まれる (既存の挙動のまま)
- `CHANGES.md` の `## develop` の該当行を Token Type 0x01 (CAT) に直す。新しい FIX エントリは足さない (未リリースの記述を正す)
- `buildAuthorizationToken` の構造は変えない。Token Type は signal の値をそのまま使い、c4m 経路では signal が `"1"` になることで 1n が載る
- 対象は devtools と `CHANGES.md` とする。relay 側の検証 (`src/msf/c4m.ts` は Base64 文字列を扱うだけで Token Type を知らない) は対象外

## 完了条件

- `applyC4mFromUrl` のあとに `buildAuthorizationToken()` を呼ぶと `tokenType === 1n` の `USE_VALUE` トークンになり、Token Value は Base64 を復号した生バイト列のままである
- 手書きの共有 URL を想定し、url パラメータに c4m を持つ MSF URL を入れ、Authorization Token のクエリパラメータ (`authorizationTokenType` / `authorizationTokenValue`) を同時に持つ URL を `initFromUrl(search)` で復元したときも `tokenType === 1n` になる (c4m が優先され、クエリの Token Value は取り込んだトークンに置き換わる)
- `authorizationTokenType` の既定値は `"0"` のままで、c4m を取り込んでいないときの手入力トークンは Token Type 0 のまま送られる。Token Type が空文字のときは 0n になる
- Token Type の入力で c4m の Base64 トークンが解除され、c4m の表示が消える
- `CHANGES.md` の `## develop` の記述が 0x01 (CAT) になる
- 上記のうち signal と `buildAuthorizationToken` の挙動が `devtools/src/signals/connectionSettings.test.ts` で固定される (`applyC4mFromUrl` を通さず `authorizationTokenBase64` を直接設定している既存テストは、c4m 経路を通る形に書き換える。`initFromUrl` は引数で検索文字列を受けるため Node で駆動できる)
- c4m の表示と Token Type 入力による解除が、実ブラウザの devtools UI テスト (`http://localhost:5173/index.html` を開く既存の形式。`tests/e2e/devtools-authorization-token.spec.ts` を追加する) で固定される。c4m の表示には `data-testid="authorization-token-c4m"` を 1 つだけ付け、テキストで探さず `getByTestId` の出現数 (取り込み後 1、解除後 0) で観測する。検索文字列は `URLSearchParams` に `set("url", "<c4m を含む MSF URL>")` して組み立てる (素の文字列連結では `#` 以降が落ちて c4m が取り込まれない)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-c4m-01 §2 (トークンはバイト列で、URL に入れるときだけ Base64 にする)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (Token Type 0x01 = CAT)
- draft-ietf-moq-c4m-01 §7.1.1 (CAT Token Type (0x01)、Token Payload は CBOR エンコードされた CWT)
- draft-ietf-moq-msf-01 §11.1.1 (c4m パラメータは Base64 エンコードされたトークン)
- draft-ietf-moq-transport-21 §8.9 (Type 0 は表に無い型で out-of-band 交渉)、§9.1.4 (SETUP では DELETE / USE_ALIAS を禁止)、§16.6 Table 12 (0x0 = Reserved)

## 解決方法

- `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は CAT を表す Token Type `"1"` (0x01) を設定するようにした (draft-ietf-moq-c4m-01 §7.1 Table 4)。JSDoc も 0x01 (CAT) と §7.1.1 (Payload は CBOR エンコードされた CWT) に直し、Token Type 0 が表に無い型で out-of-band 交渉になること (transport-21 §8.9) を根拠として明記した。Alias Type は `USE_VALUE` のままとする (§9.1.4: SETUP で DELETE / USE_ALIAS は PROTOCOL_VIOLATION)
- `authorizationTokenType` の既定値 `"0"` と、Token Type が空文字のとき 0n になるフォールバックは変えない (手入力の Token Value は UTF-8 テキストであり §7.1.1 の Payload 定義に合わないため)
- `initFromUrl` を `initFromUrl(search: string)` にし (`main.tsx` が `window.location.search` を渡す)、c4m の適用を Authorization Token のクエリパラメータより後ろへ移した。url → fragment の順に個別に適用して fragment の c4m を優先し、c4m を持つ URL ではクエリの Token Type / Token Value / Token Alias Type を置き換える。fragment に有効な c4m が無い場合と c4m が不正な場合は url の c4m を使う (何も変更しない)
  - 実装途中で「fragment パラメータの存在だけで url の c4m が捨てられる」退行を作り込んだため、レビューで検出して url → fragment の個別適用に修正し、回帰テストを追加した
- `devtools/src/components/ConnectionSettings.tsx` の Token Type 入力でも c4m から読み込んだ Base64 トークンを解除するようにし (入力した Token Type はそのまま使う)、Token Value の入力 / クリアでは解除に加えて Token Type を 0 に戻す (`clearImportedC4mToken`)。c4m を取り込んでいないときは Token Type を触らない (手入力を壊さない)。c4m の表示ブロックに `data-testid="authorization-token-c4m"` を 1 つだけ付け、Token Type / Token Value の入力にも `data-testid` を付けた
- テストは `devtools/src/signals/connectionSettings.test.ts` を c4m 経路を通る形に書き換え、`initFromUrl` の優先順位 (両方に c4m / url のみ + c4m 無し fragment / fragment 不正 / c4m 無し) と Token Type の空文字フォールバックを固定した。`tests/e2e/devtools-authorization-token.spec.ts` を追加し、c4m の表示の出現数 (取り込み後 1 / 解除後 0)、Token Type の値、Token Value 編集での解除を実ブラウザで固定した
- `CHANGES.md` の `## develop` の該当行を Token Type 0x01 (CAT) に直し、c4m の優先と解除の記述を足した (新しいエントリは足さない)

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2608 tests) / `npx vp run e2e-test` (32 passed) が通る
- 変異テストで、fragment 優先の上書き (url の c4m が失われる退行) / c4m 適用順の退行 / Token Type を 0 のままにする、のいずれでも対応するテストが失敗することを確認した (レビュアーは独立に複数種を実施)
- `clearImportedC4mToken` の呼び出し条件 (c4m 取り込み時のみ) は e2e で固定した

## 残した課題

- relay 側は c4m の Base64 文字列を扱うだけで Token Type を知らないため、0x01 を CAT として受理するかは相互運用 harness での確認が要る
- `resetAuthorizationTokenSettings` は Token Type を `"0"` に固定するため、既定値の変更は Node テストを素通りする (既定値の確認は e2e のみ)
- Token Type を手入力して解除したあと Server URL 欄を編集すると c4m が再取り込みされる (既存の挙動のまま)
- devtools の Token Type 入力の選択肢は自由入力のままで、既知の型 (0x01 = CAT など) の候補表示はしていない
