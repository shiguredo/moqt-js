# Track Namespace/Name のエンコーディング制約

## 概要

Track Namespace と Track Name のエンコーディングに関する制約を明確化する。

## 参照

- draft-ietf-moq-transport-17 Section 2.3
- https://github.com/moq-wg/moq-transport/pull/1512

## 変更内容

- draft-17 で Track Namespace と Track Name のエンコーディングとパースに関する制約が追加された
- バイト列の妥当性チェックや制約事項が明確化された

## 影響範囲

- `src/message/subscribe.ts`
- `src/message/publish.ts`
- `src/message/namespace.ts`

## 実装方針

1. draft-17 Section 2.3 のエンコーディング制約を確認する
2. Track Namespace/Name のバリデーション処理を実装する
3. テストを追加する

## 解決方法

Track Namespace/Name は既に opaque byte sequence として処理されている (`parameter.ts`)。サイズ制限 (4096 バイト) のバリデーションも実装済み。draft-17 の明確化はバイト列ベースの処理方針を確認するものであり、既存実装に合致。コード変更不要。
