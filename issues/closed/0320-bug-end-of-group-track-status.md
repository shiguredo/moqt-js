# END_OF_GROUP / END_OF_TRACK ステータスオブジェクトを送信できるようにする

- Priority: High
- Created: 2026-06-17
- Completed: 2026-06-20
- Model: Opus 4.8
- Branch: feature/fix-end-of-group-track-status
- Polished: 2026-06-20

## 目的

グループまたはトラックの終端を示す `END_OF_GROUP` / `END_OF_TRACK` ステータスを持つオブジェクトを subgropu ストリーム経由で送信できるようにする。現在の `Publisher.sendObject()` には `status` フィールドがなく、`sendObjectInternal` は `ObjectStatus.NORMAL` 固定で動作している。

## 優先度根拠

draft-ietf-moq-transport-18 §11.2.1.1 / §11.4.2 では、グループ/トラックの終端を `END_OF_GROUP`/`END_OF_TRACK` ステータスで明示できる。これを送信できないと、受信側はグループ/トラックの終了を検出できず、タイムアウトや不要な fetch/subscribe を続ける。終端シグナリングは MOQT の基本機能のため High。

## 現状

- `src/publisher.ts` の `SendObjectParams` 型（L14-20）に `status` フィールドが存在しない
- `src/session.ts` の `sendObjectInternal` L3007-3011 では `ObjectStatus.NORMAL` 固定で `encodeObjectFields` を呼んでいる
- `encodeObjectFields`（`src/dataStream.ts` L409）は既に `status: ObjectStatus` パラメータを受け付けるが、呼び出し元が常に `NORMAL` を渡している
- `SendDatagramParams`（`src/publisher.ts` L26-36）には `endOfGroup?: boolean` が既に存在し、datagram 経由の `END_OF_GROUP` 通知は対応済み。`END_OF_TRACK` は datagram では未対応だが本 issue のスコープ外とする

## 仕様根拠

draft-ietf-moq-transport-18:

- **§11.2.1.1 (Object Header)**: Object Status フィールドにより `NORMAL` (0x0)、`END_OF_GROUP` (0x3)、`END_OF_TRACK` (0x4) を区別する
- **§11.4.2 (Subgroup Header)**: Subgroup 内の最後のオブジェクトとして `END_OF_GROUP` を送信できる

## 設計方針

1. `SendObjectParams` に `status?: ObjectStatus` を追加する。省略時は `ObjectStatus.NORMAL` とし後方互換を保つ
2. `sendObjectInternal` で `params.status ?? ObjectStatus.NORMAL` を `encodeObjectFields` に渡す
3. `encodeObjectFields` の既存の制約:
   - `status !== NORMAL` かつプロパティが非空の場合に `Error` を throw している → これを `ProtocolViolationError` に修正する（デコード側と一貫させる）
   - ペイロード長が 0 の場合のみ status がエンコードされる（`encodeObjectFields` L437-442）。status が `END_OF_GROUP` / `END_OF_TRACK` でペイロード長が非ゼロの場合、status は wire に乗らず暗黙的に無視される。これを検出し `ProtocolViolationError` を投げる
4. `END_OF_TRACK` 送信後の後続オブジェクト禁止はクライアントライブラリ側では検証しない。ただし `SendObjectParams.status` の JSDoc に仕様上の制約を明記する

## 変更対象ファイル

- `src/publisher.ts`: `SendObjectParams` に `status?: ObjectStatus` を追加する。JSDoc に `END_OF_TRACK` の制約を追記する
- `src/session.ts`: `sendObjectInternal` の `ObjectStatus.NORMAL` を `params.status ?? ObjectStatus.NORMAL` に変更する
- `src/dataStream.ts`: `encodeObjectFields` の `Error` throw を `ProtocolViolationError` に修正する。非 NORMAL ステータス + 非空ペイロードの検証を追加する
- `CHANGES.md` に `[FIX]` エントリを追記する

## テスト方針

- 既存の全テストが PASS することを必須とする
- `sendObjectInternal` は `private` メソッドのため単体テスト不可。テストは `encodeObjectFields` のユニットテストとして `src/dataStream.subgroup.test.ts` に追加する:
  - `status: END_OF_GROUP, payloadLength: 0n` → エンコード結果に END_OF_GROUP ステータスが含まれること
  - `status: END_OF_TRACK, payloadLength: 0n` → エンコード結果に END_OF_TRACK ステータスが含まれること
  - `status: NORMAL, payloadLength: 0n` → エンコード結果に NORMAL ステータスが含まれること
  - `status: END_OF_GROUP, properties: nonEmpty` → `ProtocolViolationError` が throw されること
  - `status: END_OF_GROUP, payloadLength: >0` → `ProtocolViolationError` が throw されること

## 完了条件

- `SendObjectParams` に `status?: ObjectStatus` が追加される
- `sendObjectInternal` が `params.status` を正しく `encodeObjectFields` に伝搬する
- `END_OF_GROUP` / `END_OF_TRACK` の送信が可能になる
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される

## 解決方法

`SendObjectParams` に `status?: ObjectStatus` を追加し、`sendObjectInternal` で `params.status ?? ObjectStatus.NORMAL` を `encodeObjectFields` に渡すようにした。`encodeObjectFields` の `Error` throw を `ProtocolViolationError` に修正し、非 NORMAL ステータス + 非空ペイロードの検証を追加した。

変更ファイル:

- `src/publisher.ts`: `SendObjectParams.status` 追加
- `src/session.ts`: `sendObjectInternal` で `params.status` を使用
- `src/dataStream.ts`: `encodeObjectFields` のエラー種別修正と検証追加
- `src/dataStream.subgroup.test.ts`: ステータスエンコードテスト追加
- `CHANGES.md`: `[FIX]` エントリ追記
