# Relay で SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先させる

- Priority: Low
- Created: 2026-05-13
- Completed: 2026-06-02
- Model: Opus 4.7
- Branch: feature/draft-18
- Polished: 2026-06-02

## 目的

draft-18 A.1 で relay は同一 track への SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先するよう明示された。
moqt-js は relay 機能を持たないクライアントのため実装変更不要。コメント更新のみ。

## 優先度根拠

- 実装変更不要、コメント更新のみ

## 現状

クライアント専用の moqt-js では relay の優先判断は行わないため、受信側の挙動に変更はない。

draft-ietf-moq-transport-18 A.1:

> SUBSCRIBE takes precedence over SUBSCRIBE_NAMESPACE at relay (#1533)

## 設計方針

- 関連コメントの draft 参照を 17 → 18 に更新

## 完了条件

- コメントの draft 参照が 18 になっている

## 概要

draft-18 で relay は同一 track への SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先するよう明示された。
moqt-js は relay 機能を持たないクライアントなので、実装変更は不要。
コード内の参照コメントを draft-17 から draft-18 に更新する。

## RFC 参照

- draft-ietf-moq-transport-18 A.1: "SUBSCRIBE takes precedence over SUBSCRIBE_NAMESPACE at relay (#1533)"

## 該当ファイル

| ファイル         | 行番号 | 変更内容                              |
| ---------------- | ------ | ------------------------------------- |
| `src/session.ts` | 1-4    | draft 番号を 18 に更新する            |
| `src/session.ts` | 1473   | コメントの draft 参照を 18 に更新する |

## 期待される動作

- 既存の動作に変更はない
- Subscriber 側の SUBSCRIBE / SUBSCRIBE_NAMESPACE 混在時の挙動は従来通り

## テスト方針

- 既存テストの期待値変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
