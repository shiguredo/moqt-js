# REQUEST_UPDATE の coalescing 処理を許可する仕様に対応する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で連続した REQUEST_UPDATE をサーバーが coalesce (集約) して処理することが
明示的に許可された。

> A publisher MAY coalesce multiple REQUEST_UPDATE messages, processing
> only the most recent one.
>
> -- draft-ietf-moq-transport-18 §10.9

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
