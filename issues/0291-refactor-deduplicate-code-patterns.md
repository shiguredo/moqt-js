# 重複コードパターンを解消する

- Priority: Low
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18
- Polished: 2026-06-03

## 目的

以下の重複コードパターンを解消し保守性を向上させる:

1. GOAWAY Request ID チェックの重複 (5 箇所) — 詳細は #0282 で対応
2. startNamespaceStreamLoop / startTracksStreamLoop / startNamespacePublicationStreamLoop の GOAWAY ハンドリング重複 — リソース解放の追加は #0283、共通関数抽出は本 issue で対応
3. PendingPublish / PendingSubscribe / PendingFetch 型が session.ts と bidi.ts で二重定義

## 優先度根拠

コード重複はバグの温床。変更時の同期漏れリスクがある。

## 設計方針

- GOAWAY Request ID チェックを `validateGoawayOnRequestStream` に統一する
- namespace/namespace publication/tracks の GOAWAY ハンドリングを共通関数に抽出する
- Pending* 型を bidi.ts に集約し session.ts から import する

## 完了条件

- 重複コードが解消されている
- 全テストが PASS する
