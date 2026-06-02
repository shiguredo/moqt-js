# Required Request ID Delta フィールドを全リクエストメッセージから削除する

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 で Required Request ID (`requiredRequestIdDelta`) フィールドが全リクエストメッセージから削除されたため、moqt-js のワイヤーフォーマットからも削除する。

## 優先度根拠

- draft-18 準拠のために必須の破壊的変更
- 削除しないと draft-18 サーバーと通信不能になる
- 影響範囲が広い（全リクエストメッセージ）ため早期対応が必要

## 現状

draft-17 ではリクエスト間の依存関係を表現するために `requiredRequestIdDelta` フィールドが全リクエストメッセージに必須だった。
draft-18 §10.1 で Request ID 割当方式がクライアント偶数/サーバー奇数の独立した採番に単純化された。

draft-ietf-moq-transport-18 Appendix 変更履歴:

> - Remove Required Request ID (#1615)

draft-ietf-moq-transport-18 §10.1:

> The client generates even numbered Request IDs, starting at 0, and
> the server generates odd numbered Request IDs, starting at 1. Each
> endpoint increments its Request ID by 2 for each new request.

現在のコードベースでは全 9 箇所 (session.ts: 7 箇所 / bidi.ts: 2 箇所) で `requiredRequestIdDelta: 0n` がハードコードされている。
各インターフェース定義にも `requiredRequestIdDelta` フィールドが残っており、エンコード/デコードの順序に影響している。

draft-ietf-moq-transport-18 §10.1 より、Request ID を消費する全メッセージは以下:

> Each SUBSCRIBE, PUBLISH, FETCH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS,
> PUBLISH_NAMESPACE, REQUEST_UPDATE, and TRACK_STATUS message consumes a
> Request ID.

これら全 8 メッセージから `requiredRequestIdDelta` が削除されている。

## 設計方針

- 全ての `requiredRequestIdDelta` を削除する（後方互換を一切考慮しない破壊的変更）
- interface 定義、エンコード/デコード、送信コード、テスト、コメントを全て修正する
- draft-18 §10.1 の偶数/奇数採番規則に従う（Request ID フィールド自体は維持）

## 完了条件

- 全ソースコードから `requiredRequestIdDelta` への参照が完全に除去されている
- 全 PBT が `requiredRequestIdDelta` なしでラウンドトリップに成功する
- `git grep requiredRequestIdDelta` の結果が 0 件である

## 変更内容

### 1. 全リクエストメッセージの interface 定義から requiredRequestIdDelta を削除する

以下の 8 メッセージ型の interface から `requiredRequestIdDelta` フィールドと付随コメント `// 0 は依存なしを意味する` を削除する:

- `Publish` (`src/message/publish.ts:29-30`)
- `Subscribe` (`src/message/subscribe.ts:28-29`)
- `RequestUpdate` (`src/message/subscribe.ts:62-63`)
- `Fetch` (`src/message/fetch.ts:56-57`)
- `TrackStatus` (`src/message/trackstatus.ts:40-41`)
- `PublishNamespace` (`src/message/namespace.ts:25-26`)
- `SubscribeNamespace` (`src/message/namespace.ts:93-94`)
- `SubscribeTracks` (`src/message/namespace.ts:125-126`)

同時に、各エンコード/デコード関数から `requiredRequestIdDelta` のエンコード行とデコード行を除去する。

### 2. session.ts の送信コードを更新する

以下の 7 箇所から `requiredRequestIdDelta: 0n` と付随コメント `// 0 は依存なしを意味する` を削除する:

| 行番号 | コンテキスト         |
| ------ | -------------------- |
| 1200   | publish()            |
| 1329   | subscribe()          |
| 1421   | fetch() (Standalone) |
| 1483   | trackStatus()        |
| 1550   | subscribeNamespace() |
| 1636   | subscribeTracks()    |
| 2034   | publishNamespace()   |

### 3. bidi.ts の送信コードを更新する

以下の 2 箇所から `requiredRequestIdDelta: 0n` と付随コメントを削除する:

| 行番号 | コンテキスト                              |
| ------ | ----------------------------------------- |
| 514    | bidiCancelSubscription() (REQUEST_UPDATE) |
| 598    | bidiSendJoiningFetch() (Joining FETCH)    |

### 4. sendRequestUpdate の JSDoc wire format 図を更新する

`src/session.ts:2817` の `Required Request ID Delta (i),` 行を削除する。

## 該当箇所一覧

| ファイル                           | 変更内容                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/message/publish.ts:29-30`     | `Publish` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去            |
| `src/message/subscribe.ts:28-29`   | `Subscribe` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去          |
| `src/message/subscribe.ts:62-63`   | `RequestUpdate` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去      |
| `src/message/fetch.ts:56-57`       | `Fetch` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去              |
| `src/message/trackstatus.ts:40-41` | `TrackStatus` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去        |
| `src/message/namespace.ts:25-26`   | `PublishNamespace` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去   |
| `src/message/namespace.ts:93-94`   | `SubscribeNamespace` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去 |
| `src/message/namespace.ts:125-126` | `SubscribeTracks` 型から `requiredRequestIdDelta` とコメントを削除、encode/decode から除去    |
| `src/session.ts:1199-1200`         | publish() の `requiredRequestIdDelta: 0n` とコメントを削除                                    |
| `src/session.ts:1328-1329`         | subscribe() の `requiredRequestIdDelta: 0n` とコメントを削除                                  |
| `src/session.ts:1420-1421`         | fetch() (Standalone) の `requiredRequestIdDelta: 0n` とコメントを削除                         |
| `src/session.ts:1482-1483`         | trackStatus() の `requiredRequestIdDelta: 0n` とコメントを削除                                |
| `src/session.ts:1549-1550`         | subscribeNamespace() の `requiredRequestIdDelta: 0n` とコメントを削除                         |
| `src/session.ts:1635-1636`         | subscribeTracks() の `requiredRequestIdDelta: 0n` とコメントを削除                            |
| `src/session.ts:2033-2034`         | publishNamespace() の `requiredRequestIdDelta: 0n` とコメントを削除                           |
| `src/session.ts:2817`              | sendRequestUpdate() の JSDoc wire format 図から `Required Request ID Delta (i),` 行を削除     |
| `src/session/bidi.ts:514`          | bidiCancelSubscription() の `requiredRequestIdDelta: 0n` とコメントを削除                     |
| `src/session/bidi.ts:598`          | bidiSendJoiningFetch() の `requiredRequestIdDelta: 0n` とコメントを削除                       |

## テスト方針

### PBT の更新

全ラウンドトリップテストから `requiredRequestIdDelta` を削除する。対象ファイルと具体的な変更範囲:

| ファイル                          | 対象テスト                                                                               | 概要                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/message/publish.prop.ts`     | Publish のラウンドトリップ (L152-175)                                                    | `requiredRequestIdDelta` 引数と assertion を削除                                |
| `src/message/subscribe.prop.ts`   | Subscribe のラウンドトリップ (L143-158) / RequestUpdate のラウンドトリップ (L231-244)    | 両テストから `requiredRequestIdDelta` を削除                                    |
| `src/message/fetch.prop.ts`       | Fetch のラウンドトリップ / Fetch Type 不正値テスト (L256-278)                            | ラウンドトリップ + 手動ペイロード構築テストから `requiredRequestIdDelta` を削除 |
| `src/message/trackstatus.prop.ts` | TrackStatus のラウンドトリップ                                                           | `requiredRequestIdDelta` 引数と assertion を削除                                |
| `src/message/namespace.prop.ts`   | PublishNamespace (L136-180) / SubscribeNamespace (L176-378) / SubscribeTracks (L301-501) | 全 4 メッセージ種別のテストから削除                                             |

- `fetch.prop.ts:256-278`（Fetch Type 不正値テスト）は `encodeFetchPayload`/`decodeFetchPayload` を使わず手動でバイト列を構築している。`requiredRequestIdDelta` 削除に伴いペイロード構築のオフセット計算も書き換える必要がある。
- `namespace.prop.ts` の SubscribeOptions 不在テスト (L335-379, L465-501) はバイトレベルの offset アサーション (`decodeVarint(encoded, offset)` で `requiredRequestIdDelta` の位置を前提) を含むため、offset 計算を修正する必要がある。

### 結合テストの確認

- 全メッセージのラウンドトリップ PBT が `requiredRequestIdDelta` なしで正しく動作することを検証
- `session.prop.ts` 内のラウンドトリップテストに `requiredRequestIdDelta` が含まれていないか確認する

## 影響範囲

- 全リクエストメッセージのワイヤーフォーマットが変わる（後方互換なし）
- draft-17 実装のサーバーとは通信不能になる
- SETUP の Required Request ID パラメータは draft-17 ですでに削除済みのため、SETUP への追加変更は不要
- `src/message/debug.ts` / `src/message/index.ts` に間接的な参照がないか確認すること
