# GOAWAY をリクエストストリーム上で受信可能にする

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 で GOAWAY をリクエストストリーム (SUBSCRIBE / FETCH / PUBLISH 等の bidi ストリーム) 上で送信できるようになった。セッション全体の GOAWAY に加え、個別リクエスト単位でのマイグレーション指示が可能になる。

draft-ietf-moq-transport-18 Appendix 変更履歴:
> *  Allow GOAWAY on request streams (#1615)

## 優先度根拠

- draft-18 準拠のための必須対応
- 未対応の場合、リクエストストリーム上の GOAWAY が未知メッセージとして PROTOCOL_VIOLATION になりセッション切断される
- 0188 (GOAWAY に Request ID フィールド追加) と密接に関連

## 現状

現在の GOAWAY 処理は制御ストリーム (`startControlMessageLoop` → `handleGoaway`) のみに対応している。
リクエストストリーム上の GOAWAY は以下の経路で受信されうるが、いずれも未対応:

1. `src/session/bidi.ts` の `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse` — 最初の応答メッセージ読み取り。GOAWAY が最初の応答として来るケースがあるが、REQUEST_OK 以外は REQUEST_ERROR しか想定していない
2. `src/session/bidi.ts` の `bidiReadRequestStreamMessages` — 後続メッセージ読み取りループ。default 分岐で未知メッセージを PROTOCOL_VIOLATION としてセッション切断している
3. `src/session.ts` の `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` — namespace 系リクエストの応答ループ。同様に GOAWAY 未対応

`receivedGoaway` フラグはセッション全体のグローバルフラグであり、リクエストストリーム単位の GOAWAY とは分離する必要がある。

Subscriber / Publisher / Fetcher のコールバック型には現在 `goaway` コールバックが存在しない。

draft-ietf-moq-transport-18 §10.4:
> A GOAWAY message MAY be sent on any open bidirectional stream. When
> sent on a request stream, the GOAWAY applies to that specific
> request. When sent on the control stream, the GOAWAY applies to the
> entire session.

> Request ID: Present only when sent on the control stream.
> (リクエストストリーム上の GOAWAY には Request ID は含まれない)

> Upon receiving a GOAWAY on a request stream ... the endpoint
> SHOULD re-issue that specific request on a session at the
> specified URI.

> An endpoint MUST close the session with a PROTOCOL_VIOLATION if it
> receives more than one GOAWAY on the control stream or on a single
> request stream.

## 設計方針

- リクエストストリーム上の GOAWAY は個別リクエストにのみ適用され、他のリクエストやセッション全体には影響しない
- 制御ストリーム上の GOAWAY はセッション全体に適用される（既存動作を維持）
- リクエストストリーム単位の重複 GOAWAY 検出はストリームごとのローカルフラグで行う
- リクエストストリーム上の GOAWAY 受信後、ユーザーはコールバックで通知を受け、任意のタイミングで移行を判断する
- 古いリクエストストリームの close はユーザーの責任（`unsubscribe()` 等の呼び出し）とする
- moqt-js はクライアント専用のため、GOAWAY 送信は制御ストリームのみで行う（リクエストストリームでの送信は実装しない）
- Request ID は制御ストリーム上の GOAWAY のみに存在する。0188 の実装結果として、`decodeGoawayPayload` は制御・リクエスト両ストリームで使い分けられるよう `requestId` が nullable になる

## 完了条件

- リクエストストリーム上で GOAWAY (Type=0x10) を受信した場合、PROTOCOL_VIOLATION にならず当該リクエストの goaway コールバックが呼ばれる
- 同一リクエストストリームで 2 回目の GOAWAY を受信した場合、PROTOCOL_VIOLATION でセッションが閉じられる
- 制御ストリーム上の GOAWAY 受信時は従来通りセッション全体の goaway コールバックが呼ばれる
- リクエストストリーム上の GOAWAY 受信後も他のリクエストの発行が可能である
- Subscriber / Publisher / Fetcher のコールバックに `goaway?: (newSessionUri: string) => void` が追加されている

## 変更内容

### 1. Subscriber / Publisher / Fetcher に goaway コールバックを追加する

- `src/subscriber.ts`: `SubscribeCallbacks` に `goaway?: (newSessionUri: string) => void` を追加
- `src/publisher.ts`: `PublishCallbacks` に `goaway?: (newSessionUri: string) => void` を追加
- `src/fetcher.ts`: `FetchCallbacks` に `goaway?: (newSessionUri: string) => void` を追加

### 2. bidi ストリームの第一応答に GOAWAY 受信を追加する (`src/session/bidi.ts`)

- `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`:
  - REQUEST_OK / REQUEST_ERROR の分岐に加え、GOAWAY (0x10) の検出を追加
  - GOAWAY 受信時は `decodeGoawayPayload` でパースし、対応するリクエストの `goaway` コールバックを呼ぶ
  - 戻り値に `goawayUri: string | null` を追加し、呼び出し元で適切に処理する

### 3. bidi ストリームの後続メッセージに GOAWAY 受信を追加する (`src/session/bidi.ts`)

- `bidiReadRequestStreamMessages`: switch-case に `MessageType.GOAWAY` を追加し、対応リクエストの goaway コールバックを呼ぶ
- 各リクエストストリームに重複 GOAWAY 検出用のローカルフラグを導入する

### 4. namespace 系リクエストの応答ループに GOAWAY 受信を追加する (`src/session.ts`)

- `startNamespaceStreamLoop`: REQUEST_OK / REQUEST_ERROR の分岐に GOAWAY 検出を追加
- `startTracksStreamLoop`: 同様
- `startNamespacePublicationStreamLoop`: 同様

### 5. 制御ストリームの GOAWAY との分離 (`src/session.ts`)

- `receivedGoaway` フラグは制御ストリーム上の GOAWAY にのみ使用する
- リクエストストリーム上の GOAWAY は新規リクエスト発行（`publish()` / `subscribe()` 等）の拒否に影響しない

## 該当箇所一覧

| ファイル                                | 変更内容                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `src/subscriber.ts`                     | `SubscribeCallbacks` に `goaway?: (newSessionUri: string) => void` を追加 |
| `src/publisher.ts`                      | `PublishCallbacks` に `goaway?: (newSessionUri: string) => void` を追加 |
| `src/fetcher.ts`                        | `FetchCallbacks` に `goaway?: (newSessionUri: string) => void` を追加 |
| `src/session/bidi.ts:145-201`           | bidiReadPublishResponse に GOAWAY 検出を追加 |
| `src/session/bidi.ts:240-289`           | bidiReadSubscribeResponse に GOAWAY 検出を追加 |
| `src/session/bidi.ts:310-355`           | bidiReadFetchResponse に GOAWAY 検出を追加 |
| `src/session/bidi.ts:370-398`           | bidiReadTrackStatusResponse に GOAWAY 検出を追加 |
| `src/session/bidi.ts:415-486`           | bidiReadRequestStreamMessages の switch-case に GOAWAY 追加 |
| `src/session.ts:1767-1786`              | startNamespaceStreamLoop に GOAWAY 検出を追加 |
| `src/session.ts:1933-1951`              | startTracksStreamLoop に GOAWAY 検出を追加 |
| `src/session.ts:2146-2160`              | startNamespacePublicationStreamLoop に GOAWAY 検出を追加 |
| `src/session.ts:3009`                   | handleGoaway: 制御ストリーム用としてキープ、グローバルフラグと分離 |

## テスト方針

- 制御ストリーム上の GOAWAY 受信時の既存テストが引き続き動作することを確認
- リクエストストリーム上の GOAWAY 受信時に個別リクエストの `goaway` コールバックが呼ばれることを検証
- 同一リクエストストリームで 2 回目の GOAWAY 受信時に PROTOCOL_VIOLATION になることを検証
- リクエストストリーム GOAWAY 受信後も他のリクエスト種別が発行可能であることを検証
- 最初の応答として GOAWAY を受け取った場合の挙動を検証

## 影響範囲

- Subscriber / Publisher / Fetcher のコールバックに `goaway` が追加される（後方互換あり、省略可）
- `ConnectCallbacks.goaway` はセッション全体の GOAWAY として引き続き機能する
- `receivedGoaway` フラグの意味が制御ストリーム限定に変わる（破壊的変更。ただし内部実装のみで外部 API に影響なし）

## 関連 issue

- 0188: GOAWAY に Request ID フィールドを追加する。0188 完了後、`decodeGoawayPayload` の返り値に `requestId` が追加される。リクエストストリーム上の GOAWAY では `requestId` は null となる。
