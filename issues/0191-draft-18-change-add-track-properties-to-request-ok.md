# REQUEST_OK に Track Properties を追加する

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 で REQUEST_OK に Track Properties フィールドが追加された。SUBSCRIBE_OK / PUBLISH_OK / FETCH_OK 等の全リクエスト成功応答で Track Properties を受信できるようにする。

## 優先度根拠

- draft-18 準拠のための必須変更
- REQUEST_OK のワイヤーフォーマットが変わる破壊的変更
- 現在 SUBSCRIBE_OK と FETCH_OK は独自に Track Properties を持っているが、REQUEST_OK 統一後は共通化可能

## 現状

現在の `RequestOk` インターフェース (`src/message/session.ts:58-61`) は `parameters` のみで `trackProperties` がない。
SUBSCRIBE_OK と FETCH_OK はそれぞれの型 (`SubscribeOk` / `FetchOk`) で個別に Track Properties を定義している。
PUBLISH_OK 用の `PublishOk` 型には Track Properties がない。

draft-ietf-moq-transport-18 §10.5:

> REQUEST_OK Message {
> Type (vi64) = 0x7,
> Length (16),
> Number of Parameters (vi64),
> Parameters (..) ...,
> Track Properties (..),
> }

## 設計方針

- `RequestOk` 型に `trackProperties: Property[]` を追加（デフォルト空配列）
- エンコード: Parameters の後に `encodeProperties(msg.trackProperties)` の出力を連結
- デコード: Parameters の後に残りバイトがあれば `decodeProperties` で Track Properties をデコード
- `PublishOk` 型にも `trackProperties` を追加し、内部実装を RequestOk ベースに統一する（0189 と連携）
- `RequestError` クラス経由でも trackProperties を通知可能にする

## 完了条件

- `RequestOk` 型に `trackProperties: Property[]` が追加されている
- `encodeRequestOkPayload` が Track Properties のエンコードに対応している
- `decodeRequestOkPayload` が残りバイトから Track Properties をデコードできる
- Subscriber / Publisher / Fetcher が RESPONSE_OK 応答から Track Properties を参照可能
- PBT で Track Properties あり / 空の REQUEST_OK ラウンドトリップが成功する

## 変更内容

### 1. RequestOk 型に trackProperties を追加 (`src/message/session.ts`)

- `RequestOk` インターフェースに `trackProperties: Property[]` を追加
- `encodeRequestOkPayload`: Parameters 後に `encodeProperties(trackProperties)` を追加
- `decodeRequestOkPayload`: Parameters 後に残りバイトを `decodeProperties` でパース

### 2. PublishOk 型に trackProperties を追加 (`src/message/publish.ts`)

- `PublishOk` インターフェースに `trackProperties: Property[]` を追加
- `encodePublishOkPayload` / `decodePublishOkPayload` をそれぞれ `RequestOk` ベースの実装に委譲

### 3. Subscriber / Publisher / Fetcher に trackProperties を公開

- `SubscriberImpl` / `PublisherImpl` / `FetcherImpl` に `trackProperties` getter を追加
- SUBSCRIBE_OK / PUBLISH_OK / FETCH_OK 受信時に Track Properties を抽出し各インスタンスに設定

## 該当箇所一覧

| ファイル                         | 変更内容                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| `src/message/session.ts:58-61`   | `RequestOk` 型に `trackProperties: Property[]` を追加        |
| `src/message/session.ts:152-165` | `encodeRequestOkPayload` に Track Properties エンコード追加  |
| `src/message/session.ts:174-181` | `decodeRequestOkPayload` に Track Properties デコード追加    |
| `src/message/publish.ts:44-47`   | `PublishOk` 型に `trackProperties` を追加                    |
| `src/subscriber.ts`              | `SubscriberImpl` に `trackProperties` getter を追加          |
| `src/publisher.ts`               | `PublisherImpl` に `trackProperties` getter を追加           |
| `src/fetcher.ts`                 | `FetcherImpl` に `trackProperties` getter を追加             |
| `src/session.ts`                 | REQUEST_OK 受信箇所で trackProperties を各インスタンスに伝搬 |

## テスト方針

- `session.prop.ts`: Track Properties を含む REQUEST_OK のラウンドトリップ
- `session.prop.ts`: 空 Track Properties の REQUEST_OK ラウンドトリップ
- `publish.prop.ts`: PublishOk のラウンドトリップ (REQUEST_OK ベース)

## 影響範囲

- REQUEST_OK のワイヤーフォーマットが変わる（後方互換なし）
- `RequestOk` 型に `trackProperties` が追加（デフォルト空配列で後方互換あり）
- Subscriber / Publisher / Fetcher に Track Properties が公開される
