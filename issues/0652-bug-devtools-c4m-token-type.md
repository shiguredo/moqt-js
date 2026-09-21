# c4m から取り込んだトークンを Token Type 0 で送っている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-c4m-token-type
- Polished: {YYYY-MM-DD}

## 目的

MSF URL の c4m から取り込んだ CAT を out-of-band を表す Token Type 0 として送っている。draft-ietf-moq-c4m-01 §7.1 Table 4 は Token Type 0x01 を CAT として登録し、§7.1.1 は 0x01 の Token Payload を CBOR エンコードされた CWT として直列化した CAT と定めている。draft-ietf-moq-transport-21 §8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」ものと定めているため、受信側は c4m のトークンを CAT として扱わない。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は `authorizationTokenBase64` を設定したあと `authorizationTokenType.value = "0"` を設定する。JSDoc にも「Token Type を 0 (out-of-band) に設定する」と書かれている
- `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken` は c4m の Base64 を復号した生バイト列を Token Value に使い、`authorizationTokenType.value` を bigint に変換して `tokenType` に載せる。Alias Type が useValue のときは USE_VALUE、register のときは REGISTER として送る。Token Type が空文字のときは 0n にする
- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` の既定値は `"0"` であり、c4m 以外の手入力経路でも Token Type 0 が既定になる
- `devtools/src/signals/connectionSettings.ts` の `initFromUrl` は url / fragment の c4m を反映したあとにクエリパラメータの `authorizationTokenType` を適用するため、c4m と Authorization Token のクエリパラメータを同時に持つ URL では、クエリが `authorizationTokenType` を持つ場合に 0 が勝つ。引数を取らず `window.location.search` を読むため、Node のテストからは駆動できない
- `devtools/src/components/ConnectionSettings.tsx` の Token Value の入力は c4m の Base64 トークンを解除するが、Token Type の入力は解除しない
- `devtools/src/signals/connectionSettings.test.ts` は `applyC4mFromUrl` のあとの `authorizationTokenType.value` が `"0"` であることと、`authorizationTokenBase64` を直接設定したときの `tokenType === 0n` を固定している
- `CHANGES.md` の未リリースの `## develop` に、c4m のトークンを「USE_VALUE / Token Type 0 の SETUP トークンとして送る」という記述がある

## 設計方針

- `applyC4mFromUrl` は CAT を表す Token Type `"1"` (0x01) を設定し、JSDoc も 0x01 (CAT) に直す。Alias Type は `USE_VALUE` のままとする (transport-21 §9.1.4 は SETUP で DELETE / USE_ALIAS を受けたら PROTOCOL_VIOLATION と定めている)
- `authorizationTokenType` の既定値は `"0"` のまま据え置く。transport-21 §8.9 は Type 0 を「表に無い型であり out-of-band で交渉する」ものと定め、§16.6 Table 12 は 0x0 を Reserved (仕様は §8.9) として登録している。手入力の Token Value は UTF-8 テキストで CBOR エンコードされた CWT ではないため、既定を 1 にすると c4m-01 §7.1.1 の Payload 定義に反するトークンを送ることになる。既定値と、Token Type が空文字のとき 0n になるフォールバックは変えない
- `initFromUrl` は検索文字列を引数で受ける形にし (`initFromUrl(search: string)`、呼び出しは `main.tsx` が `window.location.search` を渡す。`devtools/src/webtransport-devtools/params.ts` の `parseSettingsQueryString(search)` と同じ形)、c4m の反映を Authorization Token のクエリパラメータより後ろに移す。url → fragment の順に適用し、fragment の c4m を最優先とする。c4m があるときはクエリの Token Type / Token Value を c4m の取り込みで置き換える
- `ConnectionSettings.tsx` の Token Type の入力でも、Token Value と同じく c4m の Base64 トークンを解除する。解除しないと、c4m の取り込み後に Token Type を書き換えても送信内容と UI の表示が食い違う。c4m の表示に `data-testid="authorization-token-c4m"` を付け、テキスト一致では他の要素 (ヘルプ本文) とも当たるためテストから一意に観測できるようにする。解除後に URL 欄を編集し直すと再び取り込まれる (既存の挙動のまま)
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
- c4m の表示と Token Type 入力による解除が、実ブラウザの devtools UI テスト (`http://localhost:5173/index.html` を開く既存の形式。専用の spec を追加する) で固定される。c4m の表示には `data-testid="authorization-token-c4m"` を付け、テキストで探さず `getByTestId` の出現数 (取り込み後 1、解除後 0) で観測する。検索文字列は `URLSearchParams` に `set("url", "<c4m を含む MSF URL>")` して組み立てる (素の文字列連結では `#` 以降が落ちて c4m が取り込まれない)
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-c4m-01 §2 (トークンはバイト列で、URL に入れるときだけ Base64 にする)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (Token Type 0x01 = CAT)
- draft-ietf-moq-c4m-01 §7.1.1 (CAT Token Type (0x01)、Token Payload は CBOR エンコードされた CWT)
- draft-ietf-moq-msf-01 §11.1.1 (c4m パラメータは Base64 エンコードされたトークン)
- draft-ietf-moq-transport-21 §8.9 (Type 0 は表に無い型で out-of-band 交渉)、§9.1.4 (SETUP では DELETE / USE_ALIAS を禁止)、§16.6 Table 12 (0x0 = Reserved)

## 解決方法

{未着手}
