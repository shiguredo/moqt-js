# データストリーム decode の例外がデータ不足とプロトコル違反を区別できない

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`src/session.ts` の受信ループ (`handleIncomingStream` line 3602、`processFetchObjects` line 3724、`processSubgroupObjects` line 3799) は、データストリームの decode で発生した例外を区別なく `catch {}` で握り潰してループを継続または break する。一方 `src/dataStream.ts` の `decodeSubgroupHeader` / `decodeObjectFields` / `decodeFetchObjectFields` 等は「データ不足」と「プロトコル違反 (予約値、不正な flag 組み合わせ等)」の双方で同じ `Error` を throw する。結果として、本来 PROTOCOL_VIOLATION でセッションを閉じるべきケースが「データ不足、次のチャンクを待つ」として誤ってリカバリされる。

issue #0106 (Subgroup Header の予約値で PROTOCOL_VIOLATION を発生させていない) と密接に関連するが、本 issue は decode 関数群が投げる Error の型を整理する横断的な改善を扱う。#0106 は受信ループ側の対症療法 (range 判定の追加) を中心とする。

## 根拠

draft-ietf-moq-transport-17 Section 10.4.2 (`refs/moq/draft-ietf-moq-transport-17.txt:4799-4809`):

> The following Type values are invalid. If an endpoint receives a stream header with any of these Type values, it MUST close the session with a PROTOCOL_VIOLATION:
>
> - Type values with SUBGROUP_ID_MODE set to 0b11: 0x16, 0x17, 0x1E, 0x1F, 0x36, 0x37, 0x3E, 0x3F. ...

draft-ietf-moq-transport-17 Section 10.2.1.1 等でも、Object Status の予約値や PROPERTIES bit と Properties Length の不整合、ZERO_OBJECT_ID の誤用等で PROTOCOL_VIOLATION が要求される。

これらは MUST 要件であるため、データ不足と区別して上位に伝播させる必要がある。

## 該当コード

### decode 側 (`src/dataStream.ts`)

- `decodeSubgroupHeader` (line 215): SUBGROUP_ID_MODE 違反で `throw new Error("invalid subgroup header type: ...")` (line 236, 241)。`decodeVarint` の "insufficient data" エラーも同じ catch で扱われる。
- `decodeObjectFields` (line 376): "Protocol violation: extension headers on non-Normal status object" 等を throw (line 418, 630)。
- `decodeFetchObjectFields` (line 1052): "Protocol violation: First object must have GROUP_ID_PRESENT flag set" 等を throw (line 1117, 1131, 1137, 1148, 1159, 1184)。
- `decodeFetchHeader` (line 797): 不正な type で throw (line 804)。
- `decodeObjectDatagram` (line 659): 不正な type / properties で throw (line 671, 677, 714)。

### `decodeVarint` (`src/varint.ts`)

- データ不足: `"insufficient data: need ... bytes, got ..."` (line 147, 197)。
- 不正コードポイント: `"invalid varint code point: 0xFC"` 等 (line 182, 185)。

### catch 側 (`src/session.ts`)

`handleIncomingStream` line 3602:

```typescript
} catch {
  // ヘッダーのパースに失敗した場合、データが不足している可能性
  // 次のチャンクを待つ
  if (done) break;
  continue;
}
```

`processFetchObjects` line 3724:

```typescript
} catch {
  // パースに失敗 - データが不足している可能性
  break;
}
```

`processSubgroupObjects` line 3799: 同上。

`handleIncomingDatagram` (datagram 受信、`src/session.ts:3379` 付近) でも `decodeObjectDatagram` の例外を握り潰す可能性があるため、同 issue で扱う。

## 影響

- **PROTOCOL_VIOLATION の取りこぼし**: 仕様で MUST close と定められた条件 (予約 type、flag 不整合、Object Status 不正値等) を受信しても session が閉じられない。
- **silent fail**: 不正なオブジェクトが捨てられるだけで、上位アプリケーションには通知されない。デバッグ時に問題箇所の特定が困難。
- **完全パケットの後ろの不正データ**: ストリームの途中で不正な byte 列が続いた場合、catch 後に `break` / `continue` で先送りされ、ストリーム終了 (FIN) まで到達するか、次の正しいヘッダーで運良く再同期するまで silent に進行する。

## 修正方針

1. `src/dataStream.ts` および `src/varint.ts` で投げる例外を以下 2 種類に分類する:
   - **データ不足**: `class IncompleteDataError extends Error`。decode 関数が呼ばれた時点でバッファが足りない場合に投げる。
   - **プロトコル違反**: `class ProtocolViolationError extends Error`。仕様違反の値を受信した場合に投げる。
2. `decodeVarint` の "insufficient data" を `IncompleteDataError` に置き換え、「invalid varint code point」は `ProtocolViolationError` に置き換える。
3. `decodeSubgroupHeader` / `decodeObjectFields` / `decodeFetchHeader` / `decodeFetchObjectFields` / `decodeObjectDatagram` の throw を分類する。`Error` をそのまま投げている箇所を上記 2 クラスに置き換える。
4. `src/session.ts` の receive ループ群で `catch (err)` を導入し、`if (err instanceof IncompleteDataError) { /* 次のチャンクを待つ */ }` と `if (err instanceof ProtocolViolationError) { this.closeWithError(...) }` を分岐する。それ以外の Error は予期しないバグなので `closeWithError(INTERNAL_ERROR)` する。
5. `validateObjectStatus` (`src/dataStream.ts:23`) や Properties Length 不整合 (line 714) も `ProtocolViolationError` を使うように統一する。
6. 既存テスト (`src/dataStream.test.ts` 等) で `assert.throws(...)` の正規表現マッチを使っている箇所が壊れないか確認する。

## テスト追加方針

- `src/dataStream.test.ts` に「不正な type / status / flag 組み合わせを decode したときに `ProtocolViolationError` が投げられる」テストを追加する。
- 「データ不足のバッファを decode したときに `IncompleteDataError` が投げられる」テストを追加する。
- session.ts の受信ループは WebTransport 依存のため単体テストは困難。`src/dataStream.test.ts` レベルでカバーすることを優先する。
- 既存の `decodeSubgroupHeader` テストが正規表現マッチで通っていれば、エラークラス変更後もメッセージ部分は維持して互換性を確保する。

## 関連 issue

- #0106 Subgroup Header の予約値で PROTOCOL_VIOLATION を発生させていない: 本 issue で導入する `ProtocolViolationError` を使うことで #0106 の修正がクリーンに行える。
- #0108 decodeTrackNamespace の Field Length=0 検証: 本 issue の `ProtocolViolationError` を `src/message/parameter.ts` でも利用する形に発展させられる (本 issue の対応範囲は `dataStream.ts` および `varint.ts` を主とし、message decode 系は別途検討)。

## 補足

レビュー指摘 #H1 / #H2 を受けて起票。両者は「decode 関数の例外型分離」という同一責務に属するため 1 件にまとめる。エラー型の追加は新規クラスを `error.ts` に増やすことで対応する想定だが、`Error` のサブクラスを `dataStream.ts` 内部に閉じる選択肢もあり、設計判断は実装時に再検討する。

## 解決方法

- `src/error.ts` に `IncompleteDataError` と `ProtocolViolationError` を新設し、`Error` のサブクラスとして export した。`MoqtError` 派生 (`SessionError` / `RequestError`) との混乱を避けるため、これらは error code を持たない単純な Error サブクラスとした。
- `src/varint.ts` の `decodeVarint` で「insufficient data」を `IncompleteDataError`、「invalid varint code point」を `ProtocolViolationError` に置き換えた。
- `src/dataStream.ts` の decode 系関数 (`validateObjectStatus` / `decodeSubgroupHeader` / `decodeObjectFields` / `decodeObjectDatagram` / `decodeFetchHeader` / `decodeFetchObjectFields`) で投げる仕様違反例外を `ProtocolViolationError` に置き換えた。エンコード側のバリデーション (`encodeObjectFields` / `encodeObjectDatagram` / `encodeFetchObjectFields` 等) は自分のコードに対する protection なので `Error` のままとした。
- `src/session.ts` の受信ループを以下のように分岐させた:
  - `handleIncomingStream` のヘッダーパース catch: `IncompleteDataError` → 次のチャンク待ち、`ProtocolViolationError` → `closeWithError(PROTOCOL_VIOLATION)`、その他 → `closeWithError(INTERNAL_ERROR)`
  - `handleIncomingStream` 全体の catch: `ProtocolViolationError` を検出したら `closeWithError(PROTOCOL_VIOLATION)`
  - `processFetchObjects` / `processSubgroupObjects` の catch: `IncompleteDataError` で break、それ以外は throw して上位の catch に伝播
  - `processPendingSubgroupStream` の catch: `IncompleteDataError` で break、`ProtocolViolationError` / その他で `closeWithError`
  - `handleIncomingDatagram` の catch: `ProtocolViolationError` を検出したら `closeWithError(PROTOCOL_VIOLATION)`
- メッセージは CLAUDE.md 方針に従い小文字始まり / ピリオド無しに揃え、既存テストの期待値も更新した (例: "Protocol violation: First object must have..." → "first object must have...")。
- `src/dataStream.test.ts` / `src/varint.test.ts` にエラー型 (`ProtocolViolationError` / `IncompleteDataError`) を `assert.throws(fn, Class)` で検証するテストを追加した。
- `src/message/parameter.ts` の例外型分類は本 issue のスコープ外として、引き続き `Error` のままとした。
