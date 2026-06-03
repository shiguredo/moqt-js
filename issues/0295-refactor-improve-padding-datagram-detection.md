# PADDING datagram の判定方法を改善する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

現在の PADDING datagram 判定は `decodeVarint` に依存しているが、0x132b3e29 は 4 バイト varint であり、短いデータでは不完全データエラーが発生する。より堅牢な判定方法に改善する。

本 issue は #0275 `bug-padding-datagram-short-data` の改善案として位置づけられる。#0275 が先頭バイトチェック + データ長判定による効率化を目的とするのに対し、本 issue は PADDING stream (0x132b3e28) を含めた判定ロジック全体の設計改善を扱う。実装時に統合を検討すること。

## 優先度根拠

#0275 の改善案。PADDING datagram/stream 両方の判定ロジックを根本的に見直す。

## 現状

`src/session.ts:3592-3598`:
```typescript
if (data.length > 0) {
  const [datagramType] = decodeVarint(data, 0);
  if (Number(datagramType) === 0x132b3e29) {
    return;
  }
}
```

## 設計方針

- 先頭バイトのパターンチェック + 最小データ長チェックで判定する
- データ不足時は `IncompleteDataError` を適切にハンドリングするか、上位で握り潰さない
- PADDING stream (0x132b3e28) も同様に判定改善を検討する

## 完了条件

- 1〜3 バイトの短い PADDING datagram が安全に破棄される
- 従来の 4 バイト以上の PADDING datagram も正しく破棄される
- テストが追加されている
