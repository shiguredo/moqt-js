# 複数ストリームでの auth token cache 安全性定義

## 概要

複数ストリームで auth token cache を安全に使用する方法を定義する。

## 参照

- draft-ietf-moq-transport-17 Section 13
- https://github.com/moq-wg/moq-transport/pull/1430

## 変更内容

- draft-17 で複数ストリームにわたる auth token cache の安全な使用方法が明確化された
- リクエストが双方向ストリームに移動したことにより、auth token の共有に関する考慮事項が追加された

## 影響範囲

- `src/session.ts`

## 実装方針

1. draft-17 Section 13 の auth token cache 仕様を確認する
2. 複数ストリームでの auth token 管理を適切に実装する
3. テストを追加する

## 解決方法

auth token cache のセキュリティ考慮事項の文言明確化であり、ワイヤフォーマットの変更はない。moqt-js はクライアントとして auth token を送信する側であり、cache 管理はサーバー側の責務。コード変更不要。
