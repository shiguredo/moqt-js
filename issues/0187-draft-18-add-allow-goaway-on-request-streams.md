# GOAWAY を リクエストストリーム上で送受信可能にする

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で GOAWAY を リクエストストリーム (SUBSCRIBE / FETCH / PUBLISH 等の bidi ストリーム) 上で
送信できるようになった。セッション全体の GOAWAY に加え、個別リクエスト単位でマイグレーションを促せる。

> A GOAWAY message MAY be sent on any open bidirectional stream. When
> sent on a request stream, the GOAWAY applies to that specific
> request. When sent on the control stream, the GOAWAY applies to the
> entire session.
>
> -- draft-ietf-moq-transport-18 §10.4

GOAWAY の受信ストリーム（制御ストリームかリクエストストリームか）によって適用範囲を変える必要がある。
moqt-js はクライアント専用のため、受信側のハンドリングが主な変更対象。

## 変更内容

### 1. リクエストストリーム上の GOAWAY 受信を処理する (`src/session.ts`)

- 制御ストリームループ (`startControlMessageLoop`) の GOAWAY 処理に加え、
  bidi ストリームの受信ループでも GOAWAY を検出できるようにする
- リクエストストリーム上の GOAWAY 受信時は、該当リクエスト (Subscriber/Publisher/Fetcher) の
  コールバックに `goaway` イベントとして通知する
- セッション全体の GOAWAY (制御ストリーム上) と個別リクエスト GOAWAY の判別は受信ストリーム種別で行う

### 2. Subscriber/Publisher/Fetcher に GOAWAY 通知を追加する (`src/subscriber.ts`, `src/publisher.ts`, `src/fetcher.ts`)

- `SubscribeCallbacks` に `goaway?: (newSessionUri: string) => void` を追加する
- `PublishCallbacks` に `goaway?: (newSessionUri: string) => void` を追加する
- `FetchCallbacks` に `goaway?: (newSessionUri: string) => void` を追加する

## 該当箇所

| ファイル                                    | 変更内容                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/session.ts` (handleIncomingBidiStream) | リクエストストリーム上の GOAWAY メッセージを検出し、該当リクエストのコールバックに通知する |
| `src/session.ts` (startControlMessageLoop)  | 制御ストリーム上の GOAWAY は従来通りセッション全体の GOAWAY として処理する                 |
| `src/subscriber.ts`                         | `SubscribeCallbacks` に `goaway` を追加する                                                |
| `src/publisher.ts`                          | `PublishCallbacks` に `goaway` を追加する                                                  |
| `src/fetcher.ts`                            | `FetchCallbacks` に `goaway` を追加する                                                    |
| `src/message/session.ts`                    | GOAWAY の Request ID フィールド (0188 により追加) を確認する                               |

## テスト方針

- 制御ストリーム上の GOAWAY 受信時の既存テストが引き続き動作することを確認する
- リクエストストリーム上の GOAWAY 受信時に個別リクエストのコールバックが呼ばれることを検証する

## 影響範囲

- 個別リクエスト (Subscriber/Publisher/Fetcher) のコールバックに `goaway` が追加される（後方互換あり、省略可）
- `ConnectCallbacks.goaway` はセッション全体の GOAWAY として引き続き機能する

## 関連 issue

- 0188: GOAWAY に Request ID を追加する（リクエストストリーム上の GOAWAY に Request ID が必須となるため）
