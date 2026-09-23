# docs と実装の食い違いを解消する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-sync-api-docs
- Polished: {YYYY-MM-DD}

## 目的

`docs/HIGH_LEVEL_API.md` / `docs/LOW_LEVEL_API.md` / `docs/MSF.md` / `README.md` が実装と食い違っている。docs を読んだ利用者が存在しないオプション値や受け付けられない URL を使うことになるため、実装に合わせる。

## 現状

すべて現行の docs とコードで確認した。

- `docs/HIGH_LEVEL_API.md` の `MediaSubscriber.requestKeyframe` の説明が「SUBSCRIBE_UPDATE 送信」となっている。実装 (`src/createMediaSubscriber.ts` の `requestKeyframe`) は `Subscriber.update` を呼び、`src/subscriber.ts` が §9.5 の `REQUEST_UPDATE` を送る。draft-21 に SUBSCRIBE_UPDATE は無い
- `docs/HIGH_LEVEL_API.md` の使用例 2 箇所が `https://relay.example.com/moqt` を渡している。`src/moqtUri.ts` の `normalizeMoqtUri` は `moqt://` で始まらない URL を `Error` で拒否し、`moqt://` の例は README 側にしかない
- `docs/LOW_LEVEL_API.md` の `ConnectOptions` 表が `moqtImplementation` を「SETUP Option 0x0A」としている。`SetupOptionType.MOQT_IMPLEMENTATION` は 0x07 で、draft-21 §9.1.5 (MOQT IMPLEMENTATION) も 0x07 と定める
- `docs/LOW_LEVEL_API.md` の `ConnectOptions` 表に次の 5 つが無い (`src/session/publicTypes.ts` に定義がある)
  - `maxAuthTokenCacheSize` (SETUP Option 0x04、省略時の既定 0)
  - `maxRequestUpdates` (SETUP Option 0x08、省略時の既定 0 = 無制限)
  - `maxFilterRanges` (SETUP Option 0x06、省略時の既定 0 = 受信拒否)
  - `controlMessageTimeoutMs` (省略時の既定 10,000)
  - `dataStreamTimeoutMs` (省略時の既定 30,000)
- `docs/LOW_LEVEL_API.md` の `Session` 表に `reliability` が無い (`src/session.ts` の `SessionImpl.reliability` が下位 WebTransport の値を返す)
- `docs/MSF.md` の「moqt-js での公開 API」に `MOQLOG` / `MOQMETRICS` の記載が無い。`src/index.ts` は `export * as MOQLOG` / `export * as MOQMETRICS` で公開しており、`docs/MSF.md` は `src/msf/` の API だけを列挙している。README 側の記載漏れは 0672 で扱う

## 設計方針

- docs を実装に合わせる。API 名・オプション名・既定値・使用例の URL を実装と一致させる
- `MOQLOG` / `MOQMETRICS` は `docs/MSF.md` の公開 API 一覧に追記する。README 側は 0672 で扱う
- Priority の説明は 0638 (Publisher Priority の向き) で扱うため本 issue では触れない

## 完了条件

- docs の API 名・オプション名・既定値・例が実装と一致する
- `pnpm exec vp check` が通る

## 参照

- issues/0638-bug-publisher-priority-order.md (Priority の説明。本 issue では扱わない)
- issues/0672-update-readme-implementation-status.md (README 側の記載)
- `src/session/publicTypes.ts` (`ConnectOptions` の各フィールドと既定値)
- `src/message/types.ts` (`SetupOptionType`) / `src/moqtUri.ts` (`normalizeMoqtUri`)

## 解決方法

{未着手}
