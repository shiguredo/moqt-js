# Relay で SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先させる

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で relay は同一 track への SUBSCRIBE を SUBSCRIBE_NAMESPACE より優先するよう明示された。
moqt-js は relay 機能を持たないクライアントなので、実装変更は不要。
コード内の参照コメントを draft-17 から draft-18 に更新する。

## RFC 参照

- draft-ietf-moq-transport-18 A.1: "SUBSCRIBE takes precedence over SUBSCRIBE_NAMESPACE at relay (#1533)"

## 該当ファイル

| ファイル | 行番号 | 変更内容 |
| --- | --- | --- |
| `src/session.ts` | 1-4 | draft 番号を 18 に更新する |
| `src/session.ts` | 1473 | コメントの draft 参照を 18 に更新する |

## 期待される動作

- 既存の動作に変更はない
- Subscriber 側の SUBSCRIBE / SUBSCRIBE_NAMESPACE 混在時の挙動は従来通り

## テスト方針

- 既存テストの期待値変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
