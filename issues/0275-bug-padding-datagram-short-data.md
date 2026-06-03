# PADDING datagram の短データ検出バグ

- Priority: High
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

PADDING datagram (0x132b3e29) の判定で `decodeVarint(data, 0)` を呼ぶが、0x132b3e29 は 4 バイト varint であり、data が 1〜3 バイトしかない場合 `IncompleteDataError` が throw され、誤って通常の datagram として `decodeObjectDatagram` に渡されるバグを修正する。

## 優先度根拠

短い PADDING datagram が誤って通常の datagram としてデコードされ、不正なデコード結果を生む。攻撃ベクトルにもなりうる。

## 現状

`src/session.ts:3592-3598`:
```typescript
if (data.length > 0) {
  const [datagramType] = decodeVarint(data, 0);
  if (Number(datagramType) === 0x132b3e29) {
    // PADDING datagram は破棄して何もしない
    return;
  }
}
```

draft-ietf-moq-transport-18 §11.5.2: "The receiver MUST discard the contents of a padding datagram."

## 設計方針

- PADDING datagram 判定を `decodeVarint` に頼らず、先頭バイトのパターンチェック + 最小データ長チェックで判定する
- データ不足時は `IncompleteDataError` を適切にハンドリングする
- もしくは `try/catch` で `IncompleteDataError` を捕捉し、短すぎる datagram は PADDING として扱わず上位のエラーハンドリングに委ねる

## 完了条件

- 1〜3 バイトの短い PADDING datagram が誤って通常 datagram として処理されない
- テストが追加されている
