# REQUEST_OK に Track Properties を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_OK に Track Properties フィールドが追加された。
SUBSCRIBE_OK / PUBLISH_OK / FETCH_OK の応答で Immutable Properties 等の Track Properties を
受信できるようになる。

> REQUEST_OK Message {
> Type (vi64) = 0x7,
> Length (16),
> Number of Parameters (vi64),
> Parameters (..) ...,
> Number of Track Properties (vi64),
> Track Properties (..) ...
> }
>
> -- draft-ietf-moq-transport-18 §10.5

NOTE: draft-17 では Track Properties は SUBSCRIBE_OK と FETCH_OK に個別に存在した。
draft-18 で全リクエスト応答に統一的に Track Properties が含まれるようになった。

## 変更内容

### 1. RequestOk 型に trackProperties を追加する (`src/message/session.ts`)

- `RequestOk` インターフェースに `trackProperties: Property[]` を追加する（デフォルト空配列）
- `encodeRequestOkPayload()` に Number of Track Properties + Track Properties のエンコードを追加する
- `decodeRequestOkPayload()` に Number of Track Properties + Track Properties のデコードを追加する

### 2. REQUEST_OK 受信時に Track Properties を抽出する (`src/session.ts`)

- SUBSCRIBE_OK 応答から Track Properties を抽出し Subscriber に通知する
- PUBLISH_OK 応答 (→ REQUEST_OK) から Track Properties を抽出し Publisher に通知する
- FETCH_OK 応答から Track Properties を抽出し Fetcher に通知する

### 3. Subscriber/Publisher/Fetcher に trackProperties を公開する

- `SubscriberImpl` に `trackProperties` getter を追加する
- `PublisherImpl` に `trackProperties` getter を追加する
- `FetcherImpl` に `trackProperties` getter を追加する

## 該当箇所

| ファイル                               | 変更内容                                                              |
| -------------------------------------- | --------------------------------------------------------------------- |
| `src/message/session.ts:150-200`       | `RequestOk` 型に `trackProperties` を追加し、encode/decode に反映する |
| `src/session.ts` (REQUEST_OK 受信箇所) | Track Properties を抽出して各リクエストに通知する                     |
| `src/subscriber.ts`                    | `trackProperties` getter を追加する                                   |
| `src/publisher.ts`                     | `trackProperties` getter を追加する                                   |
| `src/fetcher.ts`                       | `trackProperties` getter を追加する                                   |

## テスト方針

- `src/message/session.prop.ts`: Track Properties を含む REQUEST_OK のラウンドトリップ PBT を追加する
- `src/message/session.prop.ts`: 空 Track Properties (Number of Track Properties = 0) のテストを追加する

## 影響範囲

- REQUEST_OK のワイヤーフォーマットが変わる（後方互換なし）
- `RequestOk` 型に `trackProperties` フィールドが追加される（後方互換あり、デフォルト空配列）
- Subscriber/Publisher/Fetcher に Track Properties が公開される
