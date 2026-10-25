# 既定の Token Type が Node テストで固定されていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/test-authorization-token-default-type
- Polished: 2026-10-26

## 目的

closed の `0652-bug-devtools-c4m-token-type.md` の調査で、`devtools/src/signals/connectionSettings.test.ts` のリセットヘルパーが Token Type を `"0"` にハードコードしていることが判明した。signal の宣言時の既定値 (`signal<string>("0")`) を変えても、テストはリセットヘルパーが入れた値で走るため素通りする。既定値の確認は e2e (実ブラウザで devtools を開いて `toHaveValue("0")` を見る) だけである。

既定値は「c4m を取り込んでいないときの手入力トークンをどの Token Type で送るか」を決める値であり、`0652` は §8.9 (Type 0 は表に無い型で out-of-band 交渉) を根拠に `"0"` (out-of-band) のまま据え置くと判断した。この判断が Node テストで守られていない。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` は `signal<string>("0")` で宣言されている。直前のコメントは「デフォルト 0 = out-of-band」「c4m から取り込んだときは CAT を表す "1" が入る (`applyC4mFromUrl`)」と説明する
- 同じ節の signal も宣言時に既定値を持つ: `authorizationTokenAliasType` (`signal<AuthorizationTokenAliasTypeUi>("useValue")`) / `authorizationTokenAlias` (`signal<string>("0")`) / `authorizationTokenValue` (`signal<string>("")`) / `authorizationTokenBase64` (`signal<string>("")`)
- `devtools/src/signals/connectionSettings.test.ts` の `resetAuthorizationTokenSettings` は 5 つの signal に `"useValue"` / `"0"` / `"0"` / `""` / `""` を代入する。宣言時の既定値と同じ値のハードコードであり、宣言とテストの二重管理になっている
- `connectionSettings.test.ts` の Authorization Token を扱う各テストはリセットヘルパーを先頭で呼ぶ (例: `applyC4mFromUrl` / `buildAuthorizationToken` / `initFromUrl` のテスト)。そのため `authorizationTokenType` の宣言時の既定値を変えても Node テストは通り、`tests/e2e/devtools-authorization-token.spec.ts` の「c4m が無い URL では既定の Token Type 0 のままで c4m の表示も出ない」テストの `toHaveValue("0")` だけが落ちる
- `initFromUrl` は `authorizationTokenType` のクエリパラメータが空でない場合だけ signal を設定する (`params.get("authorizationTokenType")` の結果が真の場合に `authorizationTokenType.value = authTypeParam` を実行する)。クエリが無い場合は宣言時の既定値がそのまま使われるため、既定値は URL 復元経路にも効く
- 同型のリセットヘルパーが他にもある: `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` は複数の signal に既定値らしき値を代入し、`devtools/src/hooks/useSubscriber.test.ts` の `resetTestEnvironment` と `devtools/src/signals/subscriber.test.ts` の `resetSubscribers` も同様に signal を初期化する。`devtools/src/signals/connectionSettingsSnapshot.test.ts` の `resetSettingSignals` も Authorization Token の 5 つの signal を含む複数の signal を既定値へ戻す
- `devtools/src/signals/connectionSettings.ts` は 47 個の signal を宣言するが、`resetAuthorizationTokenSettings` がリセットするのは Authorization Token の 5 個だけである。他の signal は各テストや `resetMsfFragmentSettings` / `resetSettingSignals` などの別のヘルパーで設定・初期化しており、本 issue は Authorization Token の 5 個に絞る
- `clearImportedC4mToken` は c4m の取り込みを解除したあと `authorizationTokenType.value = "0"` を設定する。JSDoc は「Token Type を既定の 0 に戻す」と説明しており、宣言時の既定値の別のハードコードである

## 設計方針

- 既定値を 1 箇所に定義し、宣言・`resetAuthorizationTokenSettings`・`clearImportedC4mToken` の既定への復帰がそれを参照する。案: `devtools/src/signals/connectionSettings.ts` に
  - `export const AUTHORIZATION_TOKEN_DEFAULTS = { aliasType: "useValue", alias: "0", type: "0", value: "", base64: "" } as const` を置き、各 signal の宣言をその signal の型のまま `signal(...)` の引数に定数の対応する値を渡す形にする (例: `authorizationTokenType` は `signal<string>(AUTHORIZATION_TOKEN_DEFAULTS.type)`)
  - テストは `resetAuthorizationTokenSettings` でこの定数から代入し、リセット用のリテラル (`"useValue"` / `"0"` / `""`) をテストファイルから消す
  - `clearImportedC4mToken` の `authorizationTokenType.value = "0"` も `AUTHORIZATION_TOKEN_DEFAULTS.type` に置き換える
- 既定値そのものをテストで固定する。`devtools/src/signals/connectionSettings.test.ts` に「Authorization Token の既定値」を 1 件足し、`AUTHORIZATION_TOKEN_DEFAULTS` の 5 つの値すべてをリテラルで期待する (例: `type` が `"0"` であること)。定数を変えるとこのテストが落ちるため、既定値の変更が必ずテストの更新を伴う
- 既定値が実際に送信へ効くことも固定する。リセット直後に `authorizationTokenValue` を設定し、Token Type を触らずに `buildAuthorizationToken()` を呼ぶと `tokenType` が既定値由来の `0n` になることを assert する。手入力の Token Value がある状態で Token Type を触らない経路を対象にする
- `usePublisher.test.ts` / `useSubscriber.test.ts` / `subscriber.test.ts` / `connectionSettingsSnapshot.test.ts` のリセットヘルパーも同じ形に揃えるかは別 issue とする。本 issue は Authorization Token の 5 個を対象に絞る (他の既定値を変える予定が無く、変更範囲を広げない)
- 対象は `devtools/src/signals/connectionSettings.ts` / `devtools/src/signals/connectionSettings.test.ts` とする。テストの構造と重複の解消、および既定値の参照の一本化であり、公開 API と devtools の挙動は変わらないため `CHANGES.md` は触らない
- 対象外: Token Type の入力 UI (0705)、c4m の relay 受理の検証 (0703)

## 完了条件

- Authorization Token の 5 つの signal の既定値が `devtools/src/signals/connectionSettings.ts` の定数になり、宣言がその定数を参照する
- `resetAuthorizationTokenSettings` が同じ定数を参照し、`devtools/src/signals/connectionSettings.test.ts` に Token Type の `"0"` をリセット用に書いた箇所が残らない
- `clearImportedC4mToken` が Token Type を既定に戻す箇所も定数を参照する
- 既定値を固定するテストが追加され、`AUTHORIZATION_TOKEN_DEFAULTS` の値を変えるとそのテストが落ちる (実際に変えて落ちることを確認する)
- リセット直後に `authorizationTokenValue` を設定し、Token Type を触らず `buildAuthorizationToken()` を呼ぶと `tokenType` が `0n` になることが固定される
- 既存のテスト (c4m の取り込み / `buildAuthorizationToken` / `initFromUrl` の優先順位) が変わらず通る
- `tests/e2e/devtools-authorization-token.spec.ts` の「c4m が無い URL では既定の Token Type 0 のままで c4m の表示も出ない」テストの `toHaveValue("0")` が従来どおり通る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` が通る

## 参照

- draft-ietf-moq-transport-22 §8.9 (Token Type の意味。Type 0 は表に無い型で out-of-band 交渉) / §9.1.4 (AUTHORIZATION TOKEN Setup Option 0x03) / §16.6 Table 13 (登録済みの型)
- draft-ietf-moq-c4m-01 §7.1 Table 4 (0x01 = CAT) / §7.1.1 (CAT の Payload)
- closed の `0652-bug-devtools-c4m-token-type.md` (既定値 `"0"` の据え置きを判断。「残した課題」に本件がある)
- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` / `clearImportedC4mToken` (既定値の宣言と既定への復帰)
- `devtools/src/signals/connectionSettings.test.ts` の `resetAuthorizationTokenSettings` / `devtools/src/hooks/usePublisher.test.ts` の `resetPublisherSignals` / `devtools/src/hooks/useSubscriber.test.ts` の `resetTestEnvironment` / `devtools/src/signals/subscriber.test.ts` の `resetSubscribers` / `devtools/src/signals/connectionSettingsSnapshot.test.ts` の `resetSettingSignals` (同型のハードコード)
- `tests/e2e/devtools-authorization-token.spec.ts` (既定値の確認が e2e にしかない現状)

## 解決方法

{未着手}
