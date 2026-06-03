# PADDING datagram の短データ検出を改善する（バグではない）

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

PADDING datagram (0x132b3e29) の判定で `decodeVarint(data, 0)` を呼び出すが、0x132b3e29 は 4 バイト varint であり、data が 1〜3 バイトの場合 `IncompleteDataError` が投げられる。現在のコードは `catch` ブロックで `IncompleteDataError` を握り潰すため短いデータは単に破棄される（動作上は問題ない）。判定をより効率的かつ堅牢にするため、先頭バイトのパターンチェックに置き換える。

## 優先度根拠

バグではない（短い datagram は破棄されるだけ）。コードの効率化と堅牢性向上を目的とした Low 優先度の改善。

## 現状

`src/session.ts:3588-3598`:

```typescript
private handleIncomingDatagram(data: Uint8Array): void {
  try {
    if (data.length > 0) {
      const [datagramType] = decodeVarint(data, 0);
      if (Number(datagramType) === 0x132b3e29) {
        return;
      }
    }
    const [datagram] = decodeObjectDatagram(data);
    ...
  } catch (err) {
    ...
  }
}
```

`decodeVarint` はデータ不足時に `IncompleteDataError` を投げる。1〜3 バイトのデータではこの例外で `catch` ブロックに飛び、`decodeObjectDatagram` には到達しない。動作上は正しいが、無駄な例外送出が発生する。

draft-ietf-moq-transport-18 §11.5.2: "The receiver MUST discard the contents of a padding datagram."

## 設計方針

- PADDING datagram の先頭バイトは常に `0x99`（0x132b3e29 の 4 バイト varint エンコードの 1 バイト目: `1110 0100` パターン、実際の値は `0xe4`）
- 実際には `0xe4` になり、`data.length >= 4 && data[0] === 0xe4` かつ decodeVarint の結果が 0x132b3e29 であれば PADDING
- 先頭バイトチェック `data[0] === 0xe4` で PADDING の可能性をフィルタし、その場合のみ `decodeVarint` を呼ぶ
- data.length < 4 の場合は PADDING ではない（完全な varint を読めないため）

## 完了条件

- 1〜3 バイトの短いデータで `IncompleteDataError` が発生しない
- 4 バイト以上の PADDING datagram が正しく破棄される
- テストが追加されている
