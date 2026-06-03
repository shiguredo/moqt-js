# REQUEST_UPDATE の coalescing 処理を許可する仕様に対応する

- Priority: Low
- Created: 2026-05-13
- Completed: 2026-06-02
- Model: Opus 4.7
- Branch: feature/draft-18
- Polished: 2026-06-02

## 目的

draft-18 §10.9.1 で連続した REQUEST_UPDATE をサーバーが coalesce して処理することが明示的に許可された。
moqt-js はクライアント専用（送信側）のため実装変更は不要だが、コメント更新で仕様理解を明確にする。

## 優先度根拠

- 実装変更不要、コメント更新のみ

## 現状

クライアントが連続して REQUEST_UPDATE を送信しても、サーバーが最新のものだけを処理する可能性がある。
送信ロジックに変更は不要。

draft-ietf-moq-transport-18 §10.9.1:

> A receiver of multiple REQUEST_UPDATE messages on the same stream MAY
> coalesce their processing by applying only the cumulative result.

## 設計方針

- REQUEST_UPDATE 送信処理のコメントに coalescing 仕様を注記

## 完了条件

- コメントが draft-18 §10.9.1 の coalescing 仕様に言及している

## 概要

draft-18 で連続した REQUEST_UPDATE をサーバーが coalesce (集約) して処理することが
明示的に許可された。

> A receiver of multiple REQUEST_UPDATE messages on the same stream MAY
> coalesce their processing by applying only the cumulative result.
>
> -- draft-ietf-moq-transport-18 §10.9.1 (Updating Subscriptions)

moqt-js はクライアント専用（送信側）のため、連続した REQUEST_UPDATE を送信しても
サーバーが最新のものだけを処理する可能性があることを認識する必要がある。
実装上は送信ロジックに変更は不要。

## 変更内容

### 1. コメントを更新する (`src/subscriber.ts`, `src/session.ts`)

- `requestUpdate()` (→ REQUEST_UPDATE 送信) のコメントに coalescing 仕様を注記する
- 連続した REQUEST_UPDATE が個別に処理されるとは限らない旨を明記する

## 該当箇所

| ファイル                               | 変更内容                             |
| -------------------------------------- | ------------------------------------ |
| `src/subscriber.ts` (requestUpdate)    | コメントに coalescing 仕様を注記する |
| `src/session.ts` (REQUEST_UPDATE 送信) | コメントに coalescing 仕様を注記する |

## テスト方針

- 既存テストに変更は不要（クライアント側の送信処理に変更がないため）

## 影響範囲

- 実装変更なし（クライアント専用のため送信処理に影響しない）
- コメントの更新のみ

## 解決方法

moqt-js はクライアント専用実装であり、本 issue の仕様変更はクライアント側のコード変更を伴わない。仕様理解のための確認をもって完了とする。
