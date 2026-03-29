# コメント中の RFC 参照を draft-17 に更新する

Created: 2026-03-29
Model: Opus 4.6

## 概要

ソースコード中のコメントに draft-15 や draft-16 への参照が多数残っている。実装は draft-17 ベースであるため統一が必要。

## RFC 根拠

本ライブラリは draft-ietf-moq-transport-17 に基づいて実装されている。draft-15 から draft-17 にかけてセクション番号やメッセージフォーマットに変更があるため、古いドラフトのセクション番号を参照しているコメントは誤った情報源となる。

draft-15 → draft-17 で変更されたセクション番号の例:

- Section 9.2.1.12 (draft-15) → Section 9.3.11 NEW_GROUP_REQUEST (draft-17)
- Section 9.2.1.3 (draft-15) → Section 9.3.3 DELIVERY_TIMEOUT (draft-17)

## 該当箇所

- `src/session.ts`: 多数の箇所で `draft-ietf-moq-transport-16` を参照
- `src/dataStream.ts`: 多数の箇所で `draft-ietf-moq-transport-16` や `draft-15` を参照
- `devtools/src/hooks/useSubscriber.ts` 行 252: `draft-15 に準拠した Catalog 購読`
- `devtools/src/hooks/useSubscriber.ts` 行 744: `draft-ietf-moq-transport-15 Section 9.2.1.12`
- `devtools/src/signals/connectionSettings.ts` 行 25: `draft-ietf-moq-transport-15 Section 9.2.1.3`

## 修正方針

プロジェクト全体で `draft-ietf-moq-transport-15` と `draft-ietf-moq-transport-16` を検索し、該当する Section 番号も含めて draft-17 の正しいセクション番号に更新する。
