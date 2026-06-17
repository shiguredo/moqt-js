# END_OF_GROUP / END_OF_TRACK ステータスオブジェクトを送信できるようにする

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-end-of-group-track-status

## 目的

グループまたはトラックの終端を示す `END_OF_GROUP` / `END_OF_TRACK` ステータスを持つ object を送信できるようにする。現在の `Publisher` API には `status` フィールドがなく、`sendObjectInternal` は `ObjectStatus.NORMAL` 固定で動作している。

## 優先度根拠

draft-ietf-moq-transport-18 §11.2.1.1 / §11.3.1 / §11.4.2 では、グループ/トラックの終端を `END_OF_GROUP`/`END_OF_TRACK` ステータスで明示できる。これを送信できないと、受信側はグループ/トラックの終了を検出できず、タイムアウトや不要な fetch/subscribe を続ける。終端シグナリングは MOQT の基本機能のため High。

## 現状

- `src/publisher.ts` の `SendObjectParams` 型には `status` フィールドが存在しない。
- `src/session.ts` の `sendObjectInternal` L3007 付近では、object status を `ObjectStatus.NORMAL` に固定して送信している。
- `src/session.ts` の `sendDatagram` L3105 付近でも同様に `ObjectStatus.NORMAL` 固定である。

```typescript
// src/publisher.ts (概略)
export type SendObjectParams = {
  // ... status フィールドがない
};

// src/session.ts:3007 付近 (概略)
const objectStatus = ObjectStatus.NORMAL;

// src/session.ts:3105 付近 (概略)
const objectStatus = ObjectStatus.NORMAL;
```

## 仕様根拠

draft-ietf-moq-transport-18:

- **§11.2.1.1 (Object Header)**: Object Status フィールドにより `NORMAL`、`END_OF_GROUP`、`END_OF_TRACK` 等を区別する。
- **§11.3.1 (Datagram)**: Datagram 経由でも `END_OF_GROUP`/`END_OF_TRACK` ステータスを送信できる。
- **§11.4.2 (Subgroup)**: Subgroup 内の最後の object として `END_OF_GROUP` を送信できる。

## 設計方針

1. `SendObjectParams` に `status?: ObjectStatus` を追加する。省略時は従来通り `ObjectStatus.NORMAL` とし、後方互換を保つ。
2. `sendObjectInternal` と `sendDatagram` で、`params.status` があればそれを使用し、なければ `NORMAL` を使用する。
3. `END_OF_GROUP` / `END_OF_TRACK` を送信する際の payload 扱い:
   - ステータスが `NORMAL` でない場合、payload は空であることが多いが、API 利用者が意図的に payload を指定できるようにもする。
   - draft で `END_OF_GROUP`/`END_OF_TRACK` の payload に制約がある場合は従う。
4. エラー処理:
   - 無効な `status` 値が指定された場合は `PROTOCOL_VIOLATION` 等で適切にエラーを返す。
   - `END_OF_TRACK` はトラックの最後の object としてのみ送信可能な制約がある場合は検証する。

## 完了条件

- `SendObjectParams` に `status?: ObjectStatus` が追加される
- `sendObjectInternal` / `sendDatagram` が `status` フィールドを正しくワイヤーにエンコードする
- `END_OF_GROUP` / `END_OF_TRACK` の送信が可能になる
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
