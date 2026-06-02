# SUBSCRIBE_TRACKS 応答で自身の track を除外する仕様に対応する

- Priority: Low
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 §6.1 で SUBSCRIBE_TRACKS 応答に購読者自身が publish している track を含めない仕様となった。
moqt-js はクライアント専用で受信側のため、実装変更は不要だがコメント更新で仕様理解を明確にする。

## 優先度根拠

- 実装変更不要、コメント更新のみ
- 仕様理解のための documentation update

## 現状

クライアント専用の moqt-js では、relay が正しく自身の track を除外してくることを前提としている。
受信ロジックに変更は不要。

draft-ietf-moq-transport-18 §6.1:

> SUBSCRIBE_TRACKS requests track subscriptions: the publisher sends
> PUBLISH messages for tracks within matching namespaces, excluding
> tracks published by the subscriber.

## 設計方針

- SUBSCRIBE_TRACKS 応答受信処理のコメントに self-track exclusion 仕様を注記
- draft 参照を 17 → 18 に更新

## 完了条件

- コメントが draft-18 §6.1 の self-track exclusion に言及している

## 概要

draft-18 で SUBSCRIBE_TRACKS 応答に購読者自身が publish している track を含めない仕様となった。

> SUBSCRIBE_TRACKS requests track subscriptions: the publisher sends
> PUBLISH messages for tracks within matching namespaces, excluding
> tracks published by the subscriber.
>
> -- draft-ietf-moq-transport-18 §6.1

moqt-js はクライアント専用のため受信側であり、relay が正しく自身の track を除外してくることを
前提とする。実装上は受信ロジックに変更は不要だが、仕様理解として把握しておく必要がある。

## 変更内容

### 1. コメントを更新する (`src/session.ts`)

- SUBSCRIBE_TRACKS 応答受信処理のコメントに、自身の track が除外される旨を注記する
- draft-17 → draft-18 の参照を更新する

## 該当箇所

| ファイル                                     | 変更内容                     |
| -------------------------------------------- | ---------------------------- |
| `src/session.ts` (SUBSCRIBE_TRACKS 応答処理) | コメントに除外仕様を注記する |

## テスト方針

- 既存テストに変更は不要（クライアント側の受信処理に変更がないため）
- 将来 relay 機能を追加する際に self-track exclusion のテストを追加する

## 影響範囲

- 実装変更なし（クライアント専用のため受信処理に影響しない）
- コメントの更新のみ
