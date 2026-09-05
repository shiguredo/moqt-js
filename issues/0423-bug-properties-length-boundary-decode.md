# データストリーム / Datagram デコーダの Properties フィールド境界不足を修正する

- Priority: Low
- Created: 2026-08-21
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-properties-length-boundary-decode
- Polished: {YYYY-MM-DD}

## 目的

`decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` が Properties フィールドを `data.slice` で境界チェックなしに切り出し、バッファ不足時に Properties Length が実バイト数を超えると黙って切り詰めた Properties を返して `totalConsumed` を過剰に進める問題を修正する。

## 現状

- 3 つのデコーダは Properties Length を varint で読んだ後、`data.slice(offset + totalConsumed, offset + totalConsumed + propertiesLength)` で Properties バイト列を切り出す。`Uint8Array.prototype.slice` は末尾超過をクランプして短い配列を返すため、バッファが Properties バイト列の途中で切れている場合にエラーを投げず、`totalConsumed` が実バイト数を超えて進む:
  - `decodeObjectFields` (`src/dataStream.ts`): subgroup ストリーム内の Object の Properties。
  - `decodeObjectDatagram` (`src/dataStream.ts`): Object Datagram の Properties (Properties Length = 0 の PROTOCOL_VIOLATION 検証は実装済み)。
  - `decodeFetchObjectFields` (`src/dataStream.ts`): FETCH 応答の Object の Properties。
- 実害は経路ごとに異なる:
  - subgroup ストリーム経路 (`src/session/stream.ts` の `processSubgroupObjects`): `totalConsumed` の過剰進行により後続フィールド (Payload Length 等) が誤った位置から読まれ、ストリームのバイト列がずれて後続オブジェクトを誤デコードする (データ次第で誤った値が成立するか `IncompleteDataError` / `ProtocolViolationError` に至る)。
  - datagram 経路 (`src/session/incoming.ts` の `incomingHandleDatagram`): Properties と残りのペイロードが切り詰められた不正 datagram が正規オブジェクトとして配信され得る。
  - FETCH 経路 (`src/session/stream.ts` の `processFetchObjects`): subgroup 経路と同じく `totalConsumed` の過剰進行によりオブジェクトを誤デコードし得る。
- 受信側の `IncompleteDataError` の扱いは経路ごとに異なる (issue 0421 と同じ):
  - subgroup ストリーム / FETCH 経路は `processSubgroupObjects` / `processFetchObjects` (`src/session/stream.ts`) が `IncompleteDataError` で `break` しバッファを保持して次のチャンクを待つ (`src/session.ts` の `handleIncomingStream` / `handleSubgroupStream` 経由)。
  - datagram 経路 (`incomingHandleDatagram`) は `IncompleteDataError` を `toProtocolViolationSessionError` で PROTOCOL_VIOLATION に変換してセッションを閉じる (0409 / 0415 の共通解釈。既存の varint 不足・0421 の Priority バイト不足と同じ扱い)。
- issue 0421 は完了済み (2026-08-25 Closed)。本 issue はその修正パターン (`decodeFetchObjectFields` の Priority バイト境界チェック: `offset + totalConsumed >= data.length` → `IncompleteDataError`) を Properties フィールドに適用する。
- 変更対象ファイル: `src/dataStream.ts` (`decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields`)、`src/dataStream.subgroup.test.ts` / `src/dataStream.datagram.test.ts` / `src/dataStream.fetch.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- 3 つのデコーダで、Properties バイト列の切り出し前に `offset + totalConsumed + propertiesLength > data.length` を検査し、超過する場合は `IncompleteDataError` を throw する (`decodeFetchObjectFields` の Priority バイト境界チェックと同じパターン)。
- throw 後の受信側挙動は経路ごとに既存のまま維持する:
  - subgroup ストリーム / FETCH 経路: `IncompleteDataError` により次のチャンクを待つ (バッファは消費されず、揃ってから再デコードされる)。
  - datagram 経路: `IncompleteDataError` は受信側 (`incomingHandleDatagram`) で PROTOCOL_VIOLATION に変換されてセッションが閉じる (drop ではなく切断。datagram に次のチャンク待ちは構造的に不可能)。

## 完了条件

- Properties バイト列でバッファが切れている場合に `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchObjectFields` が `IncompleteDataError` を throw すること。
- subgroup ストリーム / FETCH 経路では `IncompleteDataError` により次のチャンクを待つこと、datagram 経路では PROTOCOL_VIOLATION でセッションが閉じることが、受信側の既存経路で維持されること。
- 上記を検証するテストがあること (issue 0421 で追加済みの Priority バイト境界テストと同パターン)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

未着手。
