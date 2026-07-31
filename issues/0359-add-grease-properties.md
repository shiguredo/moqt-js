# Object / Track Properties への GREASE 送信

- Created: 2026-07-31
- Completed: YYYY-MM-DD
- Branch: feature/add-grease-properties
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-transport-19 §14 (Grease) に基づき、Object Properties と Track Properties に GREASE Property を opt-in で送信する機能を実装する。

SETUP Option への GREASE 送信（`0037-add-grease-sending.md`）の後続 issue である。SETUP はセッション開始時に 1 回だけ送信されるのに対し、Properties は送信頻度が高いため、相互接続検証の効果が高い一方で性能への影響を見積もる必要がある。SETUP 側の実装と相互接続確認の結果を踏まえて着手する。

## 現状

- `src/grease.ts` に `isGreaseValue()` / `generateGreaseValue()` があるが、Properties の送信パスからの参照はない。
- `src/properties.ts` の Track Property 組み立ては concrete な `TrackPropertyId` のみで、GREASE Property を挿入しない。
- Object Properties の送信パス（`src/session/publish.ts` の `publishSendObjectInternal()` / `publishSendDatagram()` 等）も、呼び出し元から渡された `properties` をそのまま送るだけで、自動 GREASE 注入はしない。
- 受信側は対応済みである。`src/dataStream.ts` の Object Properties デコードは未知のプロパティ ID を opaque bytes として通過させる。

## 設計方針

- Track Properties（PUBLISH / SUBSCRIBE_OK / FETCH_OK で送信）と Object Properties のそれぞれに、opt-in で GREASE Property（`0x7f * N + 0x9D` パターンの Property ID + 任意の値）を 1 つ追加する。
- opt-in の手段（`ConnectOptions` のフラグか、Properties 組み立て時のオプションか）は SETUP 側の実装を踏まえて確定する。
- 送信頻度が高いパスのため、GREASE Property のサイズと送信頻度（常時か確率か）の設計判断を行う。

## 完了条件

- opt-in 指定時に Track Properties / Object Properties へ GREASE Property が含まれる。
- 既定挙動（GREASE なし）が変わらない。
- GREASE Property を含む Properties がエンコード・デコードでラウンドトリップする。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。
