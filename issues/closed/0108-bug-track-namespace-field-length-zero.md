# decodeTrackNamespace が Field Length=0 で PROTOCOL_VIOLATION を発生させていない

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`src/message/parameter.ts` の `decodeTrackNamespace()` (line 210) が、Track Namespace Field Length が 0 のフィールドを silently 受理する。draft-ietf-moq-transport-17 Section 2.3 では「Track Namespace Field Length が 0 のフィールドを受信したら PROTOCOL_VIOLATION でセッションを閉じる」ことが MUST 要件であり、現状の実装は仕様違反。

`decodeTrackNamespace` は SUBSCRIBE / PUBLISH / FETCH / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE / NAMESPACE / NAMESPACE_DONE といったほぼ全ての namespace 関連メッセージで利用されているため、影響範囲が広い。

## 根拠

draft-ietf-moq-transport-17 Section 2.3 (`refs/moq/draft-ietf-moq-transport-17.txt:974-977`):

> Each Track Namespace Field Value MUST contain at least one byte. If an endpoint receives a Track Namespace Field with a Track Namespace Field Length of 0, it MUST close the session with a PROTOCOL_VIOLATION.

なお同じ箇所で Track Namespace 全体のサイズ上限 (4,096 バイト) は既に line 234-238 でチェック済み、フィールド数上限 (32) も line 216-220 でチェック済み。残された未対応条件が Field Length=0 の検証である。

## 該当コード

`src/message/parameter.ts:225-232`:

```typescript
for (let i = 0; i < Number(numElements); i++) {
  const [elemLen, lenConsumed] = decodeVarint(data, offset + totalConsumed);
  totalConsumed += lenConsumed;
  const element = data.slice(offset + totalConsumed, offset + totalConsumed + Number(elemLen));
  elements.push(element);
  totalConsumed += Number(elemLen);
  dataSize += Number(elemLen);
}
```

`elemLen === 0n` のチェックがなく、長さ 0 のフィールドがそのまま `elements` に push される。

## 影響

- 仕様違反 peer が Field Length=0 を含むメッセージを送ってきても session が閉じられない。Section 2.3 の MUST 要件違反。
- 上位層は空フィールドを正常な値として扱う可能性があり、namespace prefix マッチング等のロジックで予期しない挙動を起こす可能性。
- 攻撃者にとって悪用容易性は低いが、相互運用性テストで指摘される可能性がある。

## 修正方針

- `decodeTrackNamespace()` のループ内で `elemLen` が 0 だった場合に専用のエラーをスローする。エラーは PROTOCOL_VIOLATION として扱える形式とする (具体的には `SessionError` ないし issue #0109 で導入予定の `ProtocolViolationError` を使うのが望ましいが、`message/parameter.ts` から `error.ts` への依存を避けたい場合は `Error` のサブクラスを定義してメッセージで識別する)。
- 本 issue の範囲では既存の `Error` を投げる方針で対応し、メッセージは `track namespace field length is zero` 等の具体的な内容にする。
- 上位の `handleControlMessage` / `handleIncomingStream` ではすでに decode の例外を捕捉して `closeWithError(PROTOCOL_VIOLATION)` する経路があるため、エラーが伝播する経路がそのままでも仕様要求を満たせるか確認する (現状は控制ストリームの decode 失敗が PROTOCOL_VIOLATION として扱われない可能性があるため、issue #0109 と合わせて検証が必要)。

## テスト追加方針

- `src/message/parameter.test.ts` に「Field Length=0 を含むバイト列を `decodeTrackNamespace` に渡すとエラーが投げられる」テストを追加する。
- エンコード形式 (varint で count、続いて各要素 length+value) を手動で組み立てて検証する。
- 既存の `decodeTrackNamespace で制限を超えるとエラー` (line 133) テストと同じスタイルで `assert.throws` を使う。

## 補足

レビュー指摘 #M4 を受けて起票。仕様違反 (MUST 要件) であるため bug カテゴリで起票する。

## 解決方法

- `src/message/parameter.ts` の `decodeTrackNamespace()` のループ内で `elemLen === 0n` を検出した場合に `Error("track namespace field length is zero")` をスローするようにした。
- 対称性のため `createTrackNamespace()` でも空文字列要素を拒否するようにした。
- `src/message/parameter.test.ts` に長さ 0 フィールド単体ケースと、複数フィールド中の 1 つが長さ 0 のケースを追加した。
- `src/message/parameter.prop.ts` のラウンドトリップ property test の文字列生成器を `minLength: 1` に変更し、空文字列で fast-check が失敗しないようにした。
- 専用の `ProtocolViolationError` 化は #0109 のスコープ。本 issue では既存の `Error` を投げる方針に留めた。`handleControlMessage` 等で例外が捕捉される経路の整理は #0109 で対応する。
