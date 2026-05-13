# REQUEST_ERROR に Redirect Structure を追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で REQUEST_ERROR に Redirect Structure が追加された。
サーバーがクライアントに対して別の接続先 (moqt URI) への再接続を指示できるようになる。

> REQUEST_ERROR Message {
>   Type (vi64) = 0x5,
>   Length (16),
>   Error Code (vi64),
>   Reason Phrase (..),
>   Number of Redirects (vi64),
>   Redirect (..) ...
> }
>
> Redirect {
>   Redirect URI Length (vi64),
>   Redirect URI (..),
> }
>
> -- draft-ietf-moq-transport-18 §10.6.2

> Relays can use REDIRECTS in response to SUBSCRIBE, FETCH, TRACK_STATUS,
> SUBSCRIBE_NAMESPACE, and SUBSCRIBE_TRACKS, unless otherwise noted.
>
> -- draft-ietf-moq-transport-18 §10.6.1

## 変更内容

### 1. Redirect Structure の型とエンコード/デコードを追加する (`src/message/session.ts`)

- `Redirect` インターフェースを新設する（`uri: string` フィールド）
- `encodeRedirect()` / `decodeRedirect()` 関数を新設する
  - URI Length (vi64) + URI (UTF-8 bytes) の形式

### 2. REQUEST_ERROR に redirects フィールドを追加する (`src/message/session.ts`)

- `RequestError` インターフェースに `redirects: Redirect[]` を追加する（デフォルト空配列）
- `encodeRequestErrorPayload()` に Number of Redirects + Redirects のエンコードを追加する
- `decodeRequestErrorPayload()` に Number of Redirects + Redirects のデコードを追加する
- 空配列の場合は Number of Redirects = 0、Redirect ブロックは省略

### 3. エラー受信時のリダイレクト通知を追加する (`src/session.ts`)

- REQUEST_ERROR 受信時に `redirects` をコールバックでアプリケーションに通知する
- Subscriber / Publisher / Fetcher のエラーコールバックに redirects 情報を含める
- `SessionImpl.requestRedirects?: string[]` でリダイレクト URI を公開する

## 該当箇所

| ファイル | 変更内容 |
|---|---|
| `src/message/session.ts:56-73` | `RequestError` 型に `redirects` を追加する |
| `src/message/session.ts:130-180` | `decodeRequestErrorPayload` に Redirect デコードを追加する |
| `src/message/session.ts:180-210` | `encodeRequestErrorPayload` に Redirect エンコードを追加する |
| `src/session.ts` (各リクエスト応答処理) | REQUEST_ERROR 受信時のリダイレクト通知コールバックを追加する |

## テスト方針

- `src/message/session.prop.ts`: Redirect 構造のエンコード/デコード ラウンドトリップ PBT を追加する
- `src/message/session.prop.ts`: REQUEST_ERROR に redirects を含む/含まないケースのラウンドトリップを追加する
- 空 redirects (Number of Redirects = 0) のエンコード/デコードを検証する

## 影響範囲

- `RequestError` 型に `redirects` フィールドが追加される（後方互換あり、デフォルト空配列）
- REQUEST_ERROR のワイヤーフォーマットが変わる（後方互換なし）
- 既存コードで `decodeRequestErrorPayload` を直接使用している箇所は `redirects` を参照する必要がある
