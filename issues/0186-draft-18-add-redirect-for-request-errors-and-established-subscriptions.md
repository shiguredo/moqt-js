# REQUEST_ERROR に Redirect Structure を追加し REDIRECT/UNSUPPORTED_EXTENSION エラーコードを追加する

- Priority: High
- Created: 2026-05-13
- Model: Opus 4.7
- Polished: 2026-06-02

## 目的

draft-18 で REQUEST_ERROR に Redirect Structure が追加され、新規エラーコード REDIRECT (0x34) と UNSUPPORTED_EXTENSION (0x33) が定義された。サーバーがクライアントに対して別の接続先 (moqt URI) への再接続を指示できるようにする。

draft-ietf-moq-transport-18 Appendix 変更履歴:
> *  Add REDIRECT for request errors and established subscriptions (#1615)

## 優先度根拠

- draft-18 準拠のために必須の追加機能
- 新規エラーコードの追加はサーバーとの相互運用に直接影響する
- 条件付きエンコード（errorCode === REDIRECT 時のみ Redirect を含む）の実装が必要

## 現状

現在の `src/message/session.ts` の `RequestError` インターフェースと `encodeRequestErrorPayload` / `decodeRequestErrorPayload` は draft-17 相当であり、以下が不足している:

1. `Redirect` 構造体の型定義・エンコード/デコードがない
2. `RequestError` インターフェースに `redirect` フィールドがない
3. `decodeRequestErrorPayload` が条件付き Redirect デコードに対応していない（errorCode === 0x34 のときのみ読み取る）
4. `encodeRequestErrorPayload` が条件付き Redirect エンコードに対応していない
5. `src/error.ts` の `RequestErrorCode` に `UNSUPPORTED_EXTENSION: 0x33` と `REDIRECT: 0x34` がない
6. `RequestError` クラスが redirect 情報を保持できない
7. `retryInterval` はデコードされているが、9 箇所の REQUEST_ERROR 受信処理で破棄されている

draft-ietf-moq-transport-18 §10.6.1 (Redirect Structure):
> Redirect {
>   Connect URI Length (vi64),
>   Connect URI (..),
>   Track Namespace (..),
>   Track Name Length (vi64),
>   Track Name (..),
> }

draft-ietf-moq-transport-18 §10.6.2 (REQUEST_ERROR Message Format):
> REQUEST_ERROR Message {
>   Type (vi64) = 0x5,
>   Length (16),
>   Error Code (vi64),
>   Retry Interval (vi64),
>   Error Reason (Reason Phrase),
>   [Redirect (Redirect),]
> }
>
> *  Redirect: Present only when Error Code is REDIRECT.  See
>    Section 10.6.1.

## 設計方針

- Redirect は REQUEST_ERROR メッセージ末尾に条件付きで存在する（errorCode === REDIRECT (0x34) のときのみ）
- `decodeRequestErrorPayload` は Error Reason の後、残りバイトがあれば Redirect をデコードする
- `encodeRequestErrorPayload` は `redirect` パラメータが undefined でなければ Redirect をエンコードする
- クライアント（moqt-js）は Redirect を受信した場合、アプリケーションのコールバックで通知する（自動追従はしない）
- `RequestError` クラスに `redirect?: Redirect` フィールドを追加する
- Redirect 内の Track Namespace は `TrackNamespace` 型を使用し、`encodeTrackNamespace` / `decodeTrackNamespace` で処理する
- moqt-js はクライアント専用のため、非ゼロ Connect URI Length の Redirect を送信することはない。受信専用。

RFC §10.6.1 のエッジケース:
- Connect URI Length = 0: SHOULD use the current session's URI（受信側で適切に扱う）
- Track Namespace と Track Name が両方とも長さ 0: same values as the original request（受信側で適切に扱う）
- namespace-scoped リクエスト (SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE) での非空 Track Name: MUST close with PROTOCOL_VIOLATION（decode 段階で検証）

## 完了条件

- `src/message/session.ts` に `Redirect` 型、`encodeRedirect`、`decodeRedirect` が追加されている
- `RequestError` インターフェースに `redirect?: Redirect` が追加されている
- `encodeRequestErrorPayload` が条件付き Redirect エンコードに対応している
- `decodeRequestErrorPayload` が残りバイトから条件付き Redirect デコードに対応している
- `src/error.ts` の `RequestErrorCode` に `UNSUPPORTED_EXTENSION: 0x33` と `REDIRECT: 0x34` が追加されている
- `RequestError` クラスに `redirect?: Redirect` フィールドがある
- `session.prop.ts` で Redirect あり/なしの REQUEST_ERROR ラウンドトリップが成功する
- 全 9 箇所の REQUEST_ERROR 受信処理で `redirect` と `retryInterval` が `RequestError` に伝搬される

## 変更内容

### 1. Redirect Structure の型とエンコード/デコードを追加する (`src/message/session.ts`)

新規追加:
- `Redirect` インターフェース
  - `connectUri: string` (Connect URI)
  - `trackNamespace: TrackNamespace` (Track Namespace、`TrackNamespace` 型を使用)
  - `trackName: Uint8Array` (Track Name)
- `encodeRedirect(redirect: Redirect): Uint8Array` 関数
  - Connect URI Length (vi64) + Connect URI (UTF-8 bytes) + encodeTrackNamespace + Track Name Length (vi64) + Track Name
- `decodeRedirect(data: Uint8Array, offset: number): [Redirect, number]` 関数
  - Connect URI 長のバリデーション: 最大 8192 バイト（GOAWAY の URI 長制限に準拠）

### 2. REQUEST_ERROR に redirect フィールドを追加する (`src/message/session.ts`)

- `RequestError` インターフェースに `redirect?: Redirect` を追加（optional、REDIRECT 時のみ存在）
- `encodeRequestErrorPayload` のシグネチャを変更:
  - 第二引数に `redirect?: Redirect` を追加
  - redirect が存在する場合、メッセージ末尾に `encodeRedirect(redirect)` のバイトを連結
- `decodeRequestErrorPayload` に Redirect の条件付きデコードを追加:
  - Error Code, Retry Interval, Error Reason をデコード後、残りバイトがあれば `decodeRedirect` を試行
  - Error Code が REDIRECT (0x34) 以外で Redirect が存在する場合: `ProtocolViolationError` を throw
  - namespace-scoped リクエスト向けの Redirect に非空 Track Name が含まれる場合: `ProtocolViolationError` を throw（moqt-js はクライアントだが、PBT 用に検証）

### 3. エラーコードの追加 (`src/error.ts`)

- `RequestErrorCode` に `UNSUPPORTED_EXTENSION: 0x33` を追加
- `RequestErrorCode` に `REDIRECT: 0x34` を追加
- `RequestError` クラスに `redirect?: { connectUri: string; trackNamespace: TrackNamespace; trackName: Uint8Array }` フィールドを追加

### 4. REQUEST_ERROR 受信処理の更新

以下の全 9 箇所で `retryInterval` と `redirect` を `RequestError` に伝搬する:

**session.ts (制御ストリーム / namespace ストリーム) — 4 箇所**:

| 行番号 | メソッド                         |
| ------ | -------------------------------- |
| 1767   | startNamespaceStreamLoop         |
| 1933   | startTracksStreamLoop            |
| 2146   | startPublishNamespaceStreamLoop  |
| 2980   | handleControlMessage             |

**session/bidi.ts (双方向ストリーム応答) — 5 箇所**:

| 行番号 | メソッド                         |
| ------ | -------------------------------- |
| 193    | bidiReadPublishResponse          |
| 281    | bidiReadSubscribeResponse        |
| 347    | bidiReadFetchResponse            |
| 390    | bidiReadTrackStatusResponse      |
| 440    | bidiReadRequestStreamMessages    |

各箇所で `new RequestError(reasonPhrase, Number(errorCode))` の呼び出しに `retryInterval` と `redirect` を渡すように変更し、`RequestError` クラスのコンストラクタを拡張する。

## 該当箇所一覧

| ファイル                        | 行番号    | 変更内容                                                         |
| ------------------------------- | --------- | ---------------------------------------------------------------- |
| `src/message/session.ts`        | 新規追加  | `Redirect` 型, `encodeRedirect()`, `decodeRedirect()` を追加     |
| `src/message/session.ts:83-88`  | 83-88     | `RequestError` インターフェースに `redirect?: Redirect` を追加   |
| `src/message/session.ts:193-211`| 193-211   | `encodeRequestErrorPayload` に条件付き Redirect エンコードを追加 |
| `src/message/session.ts:220-247`| 220-247   | `decodeRequestErrorPayload` に条件付き Redirect デコードを追加   |
| `src/error.ts:47-64`            | 47-64     | `RequestErrorCode` に 0x33, 0x34 を追加                          |
| `src/error.ts:141-146`          | 141-146   | `RequestError` クラスに redirect フィールドと retryInterval を追加 |
| `src/session.ts:1767-1786`      | 1767-1786 | startNamespaceStreamLoop: retryInterval/redirect を RequestError に伝搬 |
| `src/session.ts:1933-1951`      | 1933-1951 | startTracksStreamLoop: retryInterval/redirect を RequestError に伝搬 |
| `src/session.ts:2146-2160`      | 2146-2160 | startPublishNamespaceStreamLoop: retryInterval/redirect を伝搬 |
| `src/session.ts:2980`           | 2980      | handleControlMessage: retryInterval/redirect を RequestError に伝搬 |
| `src/session/bidi.ts:193-201`   | 193-201   | bidiReadPublishResponse: retryInterval/redirect を伝搬 |
| `src/session/bidi.ts:281-289`   | 281-289   | bidiReadSubscribeResponse: retryInterval/redirect を伝搬 |
| `src/session/bidi.ts:347-355`   | 347-355   | bidiReadFetchResponse: retryInterval/redirect を伝搬 |
| `src/session/bidi.ts:390-398`   | 390-398   | bidiReadTrackStatusResponse: retryInterval/redirect を伝搬 |
| `src/session/bidi.ts:440-453`   | 440-453   | bidiReadRequestStreamMessages: retryInterval/redirect を伝搬 |

## テスト方針

### PBT の追加 (`src/message/session.prop.ts`)

- Redirect 構造のエンコード/デコード ラウンドトリップ
  - Connect URI: 空文字列を含む任意の ASCII 文字列 (最大 8192 バイト)
  - Track Namespace: 0〜32 タプルの TrackNamespace
  - Track Name: 任意の Uint8Array (空バイトを含む)
- REQUEST_ERROR with Error Code = REDIRECT + Redirect あり: ラウンドトリップ
- REQUEST_ERROR with Error Code ≠ REDIRECT + Redirect なし: ラウンドトリップ
- REQUEST_ERROR with Error Code ≠ REDIRECT かつ Redirect ありバイト列: `ProtocolViolationError` が throw される
- namespace-scoped 向け Redirect に非空 Track Name が含まれる: `ProtocolViolationError` が throw される
- Connect URI Length が 8192 バイト超過: エラーが throw される

### 単体テスト

- `RequestError` クラスが redirect / retryInterval を正しく保持することを検証

## 影響範囲

- `RequestError` インターフェースに `redirect` フィールドが追加される（後方互換あり、optional）
- `RequestError` クラスのコンストラクタシグネチャが拡張される
- REQUEST_ERROR のワイヤーフォーマットが変わる（後方互換なし）
- 全 9 箇所の REQUEST_ERROR 受信処理で `retryInterval` の伝搬が追加される（既存の破棄動作が改善される）
- `encodeRequestErrorPayload` のシグネチャが変わる（第二引数追加）
