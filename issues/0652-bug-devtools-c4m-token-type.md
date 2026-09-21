# c4m から取り込んだトークンを Token Type 0 で送っている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-c4m-token-type
- Polished: {YYYY-MM-DD}

## 目的

MSF URL の c4m から取り込んだ CAT を out-of-band の Token Type 0 として送っている。draft-ietf-moq-c4m-01 §7.1 は Token Type 0x01 を CAT として登録しており、受信側は Token Type 0 を表に無い型として扱うため、c4m で認可する relay に対してトークンが機能しない。

## 現状

- `devtools/src/signals/connectionSettings.ts` の `applyC4mFromUrl` は `authorizationTokenBase64` を設定したあと `authorizationTokenType.value = "0"` を設定する。JSDoc にも「Alias Type を useValue、Token Type を 0 (out-of-band) に設定する」と書かれている
- `devtools/src/signals/connectionSettings.ts` の `buildAuthorizationToken` は `authorizationTokenType.value` を bigint に変換して `tokenType` に載せ、Alias Type を `USE_VALUE` にして送る
- `devtools/src/signals/connectionSettings.ts` の `authorizationTokenType` の既定値は `"0"` であり、c4m 以外の経路でも Token Type 0 が既定になる
- `devtools/src/signals/connectionSettings.test.ts` の `applyC4mFromUrl` のテストが `authorizationTokenType.value` が `"0"` であることを固定している

## 設計方針

- `applyC4mFromUrl` は CAT を表す Token Type `"1"` (0x01) を設定する。Alias Type は `USE_VALUE` のままとする (SETUP の AUTHORIZATION_TOKEN は DELETE / USE_ALIAS を禁止されている)
- `authorizationTokenType` の既定値も見直す。c4m 以外の手入力経路の挙動が変わるため、既定値を変えるかどうかは Token Type 0 が「表に無い型」である意味を踏まえて決める
- `applyC4mFromUrl` の JSDoc を更新する
- 既存テストの期待値を更新し、Token Type 1 で送られることを固定する

## 完了条件

- c4m から取り込んだトークンが Token Type 0x01 (CAT) として送られる
- Token Type の既定値が仕様と矛盾しない
- `devtools/src/signals/connectionSettings.test.ts` で固定される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-c4m-01 §7.1 Table 4 (Token Type 0x01 = CAT)
- draft-ietf-moq-c4m-01 §7.1.1 (CAT Token Type (0x01))
- draft-ietf-moq-transport-21 §8.9 「Type 0 is reserved to indicate that the type is not defined in the table and is negotiated out-of-band between client and receiver.」
- draft-ietf-moq-transport-21 §16.6 Table 12 (0x0 = Reserved)

## 解決方法

{未着手}
