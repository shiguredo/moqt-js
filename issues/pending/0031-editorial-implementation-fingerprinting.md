# MOQT_IMPLEMENTATION のセキュリティ考慮

## 概要

MOQT_IMPLEMENTATION Setup Option のセキュリティ・プライバシー考慮事項を追加する。

## 参照

- draft-ietf-moq-transport-17 Section 13
- https://github.com/moq-wg/moq-transport/pull/1511

## 変更内容

- draft-17 で MOQT_IMPLEMENTATION Setup Option によるフィンガープリンティングのリスクに関するセキュリティ考慮事項が追加された
- 実装バージョンを公開することのプライバシーリスクが指摘された

## 影響範囲

- `src/message/setup.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 13 のセキュリティ考慮事項を確認する
2. MOQT_IMPLEMENTATION の送信をオプションにする、または無効化可能にする
3. 必要に応じてドキュメントコメントを追加する

## pending 理由

MOQT_IMPLEMENTATION の送信をオプション化する独自機能の追加が必要。設計判断が必要（デフォルトで送信するか否か、API 設計など）。
