# Required Request ID Delta フィールドを全リクエストメッセージから削除する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Required Request ID (requiredRequestIdDelta) フィールドが全リクエストメッセージから削除された。
draft-17 ではリクエスト間の依存関係を表現するために `requiredRequestIdDelta` が必須だったが、
draft-18 §10.1 で Request ID 割当方式がクライアント偶数/サーバー奇数の独立した採番に単純化された。

> The client generates even numbered Request IDs, starting at 0, and
> the server generates odd numbered Request IDs, starting at 1. Each
> endpoint increments its Request ID by 2 for each new request.
>
> -- draft-ietf-moq-transport-18 §10.1

requiredRequestIdDelta は draft-17 で存在した「次に割り当てるべき Request ID」の交渉機構の残滓であり、
削除によりエンコード/デコードが単純化される。

## 変更内容

### 1. 全リクエストメッセージから requiredRequestIdDelta を削除する

以下のメッセージ型から `requiredRequestIdDelta` フィールドを削除し、エンコード/デコードから該当処理を除去する:

- `Publish` (`src/message/publish.ts`)
- `Subscribe` (`src/message/subscribe.ts`)
- `Fetch` (`src/message/fetch.ts`)
- `TrackStatus` (`src/message/trackstatus.ts`)
- `PublishNamespace` (`src/message/namespace.ts`)
- `SubscribeNamespace` (`src/message/namespace.ts`)
- `RequestUpdate` (`src/message/subscribe.ts`)

### 2. session.ts の送信コードを更新する

- 全リクエストメッセージ構築時に `requiredRequestIdDelta: 0n` を削除する
- コメント `// Required Request ID Delta (vi64) - draft-ietf-moq-transport-17 Section 9.2` を削除する（計 8 箇所）

### 3. bidi.ts の送信コードを更新する

- `bidiSendJoiningFetch()` の Fetch 構築から `requiredRequestIdDelta: 0n` を削除する
- `bidiCancelSubscription()` の RequestUpdate 構築から `requiredRequestIdDelta: 0n` を削除する

## 該当箇所

| ファイル                           | 変更内容                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/message/publish.ts:29-31`     | `Publish` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去            |
| `src/message/subscribe.ts:28-30`   | `Subscribe` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去          |
| `src/message/subscribe.ts:62-64`   | `RequestUpdate` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去      |
| `src/message/fetch.ts:56-58`       | `Fetch` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去              |
| `src/message/trackstatus.ts:40-42` | `TrackStatus` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去        |
| `src/message/namespace.ts:25-27`   | `PublishNamespace` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去   |
| `src/message/namespace.ts:88-90`   | `SubscribeNamespace` 型から `requiredRequestIdDelta` を削除、エンコード/デコードから除去 |
| `src/session.ts` (8箇所)           | `requiredRequestIdDelta: 0n` を削除                                                      |
| `src/session/bidi.ts:514,598`      | `requiredRequestIdDelta: 0n` を削除                                                      |

## テスト方針

### PBT の更新

- `src/message/publish.prop.ts`: `requiredRequestIdDelta` をテストから削除
- `src/message/subscribe.prop.ts`: `requiredRequestIdDelta` をテストから削除
- `src/message/fetch.prop.ts`: `requiredRequestIdDelta` をテストから削除
- `src/message/trackstatus.prop.ts`: `requiredRequestIdDelta` をテストから削除
- `src/message/namespace.prop.ts`: `requiredRequestIdDelta` をテストから削除
- `src/message/subscribe.prop.ts` (RequestUpdate): `requiredRequestIdDelta` をテストから削除

### 結合テストの確認

- 全メッセージのラウンドトリップ PBT が `requiredRequestIdDelta` なしで正しく動作することを検証

## 影響範囲

- 全リクエストメッセージのワイヤーフォーマットが変わる（後方互換なし）
- SETUP の Required Request ID パラメータは draft-17 ですでに削除済みのため、SETUP への追加変更は不要
