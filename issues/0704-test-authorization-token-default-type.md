# 既定の Token Type が Node テストで固定されていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-authorization-token-default-type
- Polished: 2026-09-24

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` の調査で、`devtools/src/signals/connectionSettings.test.ts` のリセットヘルパーが Token Type を `"0"` にハードコードしていることが判明した。signal の宣言時の既定値 (`signal<string>("0")`) を変えても、テストはリセットヘルパーが入れた値で走るため素通りする。既定値の確認は e2e (実ブラウザで devtools を開いて `toHaveValue("0")` を見る) だけである。

既定値は「c4m を取り込んでいないときの手入力トークンをどの Token Type で送るか」を決める値であり、`0652` は transport-21 §8.9 を根拠に `"0"` (out-of-band) のまま据え置くと判断した。この判断が Node テストで守られていない。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` は `signal<string>("0")` (87 行目)。直前のコメント (85-86 行目) が「デフォルト 0 = out-of-band」「c4m から取り込んだときは CAT を表す "1" が入る (`applyC4mFromUrl`)」と説明する
- 同じ節の signal も宣言時に既定値を持つ: `authorizationTokenAliasType` (82 行目、`"useValue"`) / `authorizationTokenAlias` (84 行目、`"0"`) / `authorizationTokenValue` (89 行目、`""`) / `authorizationTokenBase64` (93 行目、`""`)
- `devtools/src/signals/connectionSettings.test.ts` の `resetAuthorizationTokenSettings` (15 行目) は 5 つの signal に `"useValue"` / `"0"` / `"0"` / `""` / `""` を代入する (16-20 行目)。宣言時の既定値と同じ値のハードコードであり、宣言とテストの二重管理になっている
- 各テストはリセットヘルパーを先頭で呼ぶ (例: 30 行目 / 77 行目 / 105 行目のテスト)。そのため `authorizationTokenType` の宣言時の既定値を変えても Node テストは通り、`tests/e2e/devtools-authorization-token.spec.ts` の「c4m が無い URL では既定の Token Type 0 のまま」の assert (48-52 行目、52 行目が `toHaveValue("0")`) だけが落ちる
- `initFromUrl` (421 行目) は `authorizationTokenType` のクエリパラメータがある場合だけ signal を設定する (520-522 行目)。クエリが無い場合は宣言時の既定値がそのまま使われるため、既定値は URL 復元経路にも効く
- 同型のリセットヘルパーが他にもある: `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` (59 行目、60-93 行目の 34 個の signal に既定値らしき値を代入)、`devtools/src/hooks/useSubscriber.test.ts` の `resetTestEnvironment` (55 行目、2 個)、`devtools/src/signals/subscriber.test.ts` の `resetSubscribers` (24 行目、1 個)
- `devtools/src/signals/connectionSettings.ts` は 28 個の signal を宣言する (23-93 行目) が、テストがリセットするのは Authorization Token の 5 個だけである (他はテストが触らないため持ち越しが起きにくい)

## 設計方針

- 既定値を 1 箇所に定義し、宣言とテストのリセットの双方がそれを参照する。案: `devtools/src/signals/connectionSettings.ts` に
  - `AUTHORIZATION_TOKEN_DEFAULTS = { aliasType: "useValue", alias: "0", type: "0", value: "", base64: "" } as const` を置き、各 signal の宣言を `signal<string>(AUTHORIZATION_TOKEN_DEFAULTS.type)` の形にする
  - テストは `resetAuthorizationTokenSettings` でこの定数から代入し、テストファイルから `"0"` などのリテラルを消す
- 既定値そのものをテストで固定する。`devtools/src/signals/connectionSettings.test.ts` に「Authorization Token の既定値」を 1 件足し、`AUTHORIZATION_TOKEN_DEFAULTS` の中身をリテラルで期待する (例: `type` が `"0"` であること)。定数を変えるとこのテストが落ちるため、既定値の変更が必ずテストの更新を伴う
- 既定値が実際に送信へ効くことも固定する。リセット直後 (クエリも c4m も適用しない状態) に `buildAuthorizationToken()` を呼ぶと `tokenType` が既定値由来の `0n` になることを assert する。手入力の Token Value がある状態で Token Type を触らない経路を対象にする
- `usePublisher.test.ts` / `useSubscriber.test.ts` / `subscriber.test.ts` のリセットヘルパーも同じ形に揃えるかは別 issue とする。本 issue は Authorization Token の 5 個を対象に絞る (他の既定値を変える予定が無く、変更範囲を広げない)
- 対象は `devtools/src/signals/connectionSettings.ts` / `devtools/src/signals/connectionSettings.test.ts` とする。テストの構造と重複の解消であり、公開 API と devtools の挙動は変わらないため `CHANGES.md` は触らない
- 対象外: Token Type の入力 UI (0705)、c4m の relay 受理の検証 (0703)

## 完了条件

- Authorization Token の 5 つの signal の既定値が `devtools/src/signals/connectionSettings.ts` の定数になり、宣言がその定数を参照する
- `resetAuthorizationTokenSettings` が同じ定数を参照し、`devtools/src/signals/connectionSettings.test.ts` に Token Type の `"0"` をリセット用に書いた箇所が残らない
- 既定値を固定するテストが追加され、`AUTHORIZATION_TOKEN_DEFAULTS` の値を変えるとそのテストが落ちる (実際に変えて落ちることを確認する)
- リセット直後に Token Type を触らず `buildAuthorizationToken()` を呼ぶと `tokenType` が `0n` になることが固定される
- 既存のテスト (c4m の取り込み / `buildAuthorizationToken` / `initFromUrl` の優先順位) が変わらず通る
- `tests/e2e/devtools-authorization-token.spec.ts` の既定値の確認 (52 行目) が従来どおり通る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §8.9 (Token Type の意味。Type 0 は表に無い型で out-of-band 交渉) / §9.1.4 (AUTHORIZATION TOKEN Setup Option 0x03) / §16.6 Table 12 (登録済みの型)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload)
- closed の `0652-bug-devtools-c4m-token-type.md` (既定値 `"0"` の据え置きを判断。「残した課題」に本件がある)
- `devtools/src/signals/connectionSettings.test.ts` の `resetAuthorizationTokenSettings` / `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` (同型のハードコード)
- `tests/e2e/devtools-authorization-token.spec.ts` (既定値の確認が e2e にしかない現状)

## 解決方法

{未着手}
