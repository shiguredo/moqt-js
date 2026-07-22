# Track Properties 内の未知 Mandatory Track Property (0x4000-0x7FFF) の処理が未実装

- Priority: High
- Created: 2026-06-30
- Completed: 2026-07-23
- Model: Kimi Code CLI
- Branch: feature/fix-mandatory-track-properties-handling
- Polished: 2026-07-23

## 目的

draft-18 §2.5.1 で定義された Mandatory Track Properties（Property Type 0x4000-0x7FFF）の処理規則を実装する。未知の Mandatory Track Property を含む Track を受信した場合、処理・転送してはならない（MUST NOT）。

## 優先度根拠

- draft-18 §2.5.1: "An endpoint that receives an unknown Mandatory Track Property in a Track Properties list MUST NOT process or forward that track." — 未知の Mandatory Track Property を含む Track の処理・転送を禁止する MUST NOT 要件。
- draft-18 §2.5.1: PUBLISH 受信時は "the subscriber MUST respond with REQUEST_ERROR with error code UNSUPPORTED_EXTENSION"、SUBSCRIBE_OK / FETCH_OK 受信時は "the subscriber MUST cancel the subscription" / "the subscriber MUST cancel the fetch"。
- draft-18 §15.8: Property Type 0x4000-0x7FFF は "Mandatory Track Properties 用に予約 (Track scope のみ)"。
- 未知の Mandatory Track Property を無視すると、将来の拡張との相互運用で誤動作する。
- 過去 issue #0192 のコミット（d0a2345）はコミットメッセージに「decodeProperties の未知拡張処理に mandatory 範囲チェックを追加」と記載しているが、実際の diff は `parseProperties()` のみ修正しており、`decodeProperties()` には最初からチェックが追加されていない。#0192 は未完了のまま close された。

## 現状

### `decodeProperties()`（Track Properties 用）にチェックがない

`src/properties.ts` の `decodeProperties()` は未知の Property Type を区別なく `Property[]` に追加する。0x4000-0x7FFF 範囲の未知 Property を検出して拒否するロジックがない。

`decodeProperties()` は以下のメッセージデコードから呼び出される:

- `src/message/publish.ts:decodePublishPayload()`（PUBLISH 受信）
- `src/message/subscribe.ts:decodeSubscribeOkPayload()`（SUBSCRIBE_OK 受信）
- `src/message/fetch.ts:decodeFetchOkPayload()`（FETCH_OK 受信）
- `src/message/session.ts:decodeRequestOkPayload()`（REQUEST_OK 受信。PUBLISH_OK / REQUEST_UPDATE_OK 等。ただし `bidi.ts` で Track Properties 空チェック済みのため実害なし）

### `parseProperties()`（Object Properties 用）にはチェックがあるがランタイム未使用

`src/properties.ts` の `parseProperties()` は 0x4000-0x7FFF を `MalformedTrackError` で拒否する。しかし `parseProperties()` はテスト（`properties.test.ts`、`properties.prop.ts`）からしか呼ばれておらず、本番のデータパスでは使用されていない。

### エラーハンドリング経路の欠陥

`decodeProperties()` に `MalformedTrackError` の throw を追加しても、現在のエラーハンドリング経路では正しく処理されない:

1. **PUBLISH 受信**（`src/session.ts` 4020-4031 行目）: `decodePublishPayload()` の catch ブロックは `toProtocolViolationSessionError(err)`（`src/session/errors.ts`）のみ処理する。この関数は `ProtocolViolationError` のみを変換し、`MalformedTrackError` には `null` を返す。結果としてエラーは黙って握り潰されて `return` するだけで、REQUEST_ERROR(UNSUPPORTED_EXTENSION) は送信されない。
2. **SUBSCRIBE_OK 受信**（`src/session/bidi.ts` の `bidiReadSubscribeResponse()`）: catch ブロックは `pending.reject(error)` のみ実行する。仕様 §2.5.1 が要求するキャンセル処理（ストリームのクローズ・状態清理）が明示的に行われない。
3. **FETCH_OK 受信**（`src/session/bidi.ts` の `bidiReadFetchResponse()`）: 同様に `pending.reject(error)` のみ。

### Relay 要件について

仕様 §2.5.1 は Relay に対して下流への REQUEST_ERROR 転送を MUST で求めているが、moqt-js はクライアントライブラリであり Relay ではないため、Relay 要件は本 issue の対象外とする。

## 設計方針

- `decodeProperties()` 内で、未知の Property Type が 0x4000-0x7FFF 範囲にある場合、`MalformedTrackError` を throw する。チェックは偶数 ID / 奇数 ID の分岐前の共通パスに配置する。エラーメッセージは `parseProperties()` の既存チェックと同一（`unknown mandatory track property: type 0x${id.toString(16)}`）にする。
- 既知の Track Property ID（`TrackPropertyId` / `MOQTPropertyId` に定義済み）は 0x4000-0x7FFF 範囲外のため影響を受けない。
- **PUBLISH 受信時**（`src/session.ts`）: catch ブロックに `MalformedTrackError` の分岐を追加し、`sendRequestErrorAndCancel(stream, RequestErrorCode.UNSUPPORTED_EXTENSION, ...)` を呼び出す。`ProtocolViolationError` の場合は従来通り `closeWithError`。
- **SUBSCRIBE_OK / FETCH_OK 受信時**（`src/session/bidi.ts`）: catch ブロックに `MalformedTrackError` の分岐を追加し、`pending.reject(error)` で Promise を reject する。呼び出し元（Subscriber / Fetcher）が reject を処理してサブスクリプション / フェッチをキャンセルする。
- Immutable Properties 内部にネストされた Mandatory Track Property の扱いは本 issue の対象外とする（`decodeProperties()` の再帰チェックループは IMMUTABLE_PROPERTIES の再帰のみを検査しており、0x4000-0x7FFF の検査は追加しない。仕様上 Mandatory Track Property が Immutable Properties 内に出現し得るかは別途検討）。
- 非 Mandatory 範囲（例: 0x3800-0x3FFF のアプリケーション固有、0x8000 以上の First Come First Served）の未知 Property は従来通り unknown として保持する。

## 完了条件

- `decodeProperties()` が未知の Mandatory Track Property（0x4000-0x7FFF）を含むデータで `MalformedTrackError` を throw すること。
- 境界値: 0x3FFF（非 Mandatory 最大）は通過、0x4000（Mandatory 最小）は拒否、0x7FFF（Mandatory 最大）は拒否、0x8000（Mandatory 超）は通過。
- 既知の TrackPropertyId（0x02, 0x04, 0x06, 0x0E, 0x22, 0x30）は 0x4000-0x7FFF 範囲外のため影響を受けないこと。
- PUBLISH 受信時に未知 Mandatory Track Property が含まれる場合、`REQUEST_ERROR(UNSUPPORTED_EXTENSION)` が送信されること。
- SUBSCRIBE_OK / FETCH_OK 受信時に未知 Mandatory Track Property が含まれる場合、サブスクリプション / フェッチがキャンセルされること。
- 非 Mandatory 範囲（例: 0x3800）の未知 Property は従来通り unknown として保持されること。
- 既存の PBT テスト（`session.prop.ts`、`publish.prop.ts`、`subscribe.prop.ts`、`fetch.prop.ts`、`session.prop.ts`）が 0x4000-0x7FFF 範囲を生成しないため影響を受けないこと。

## 解決方法

1. `src/properties.ts` の `decodeProperties()` に 0x4000-0x7FFF 範囲の未知 Property 検出を追加する。偶数 ID / 奇数 ID の分岐前の共通パスでチェックし、`MalformedTrackError` を throw する。
2. `src/session.ts` の PUBLISH 受信 catch ブロック（4020-4031 行目付近）に `MalformedTrackError` の分岐を追加し、`REQUEST_ERROR(UNSUPPORTED_EXTENSION)` を送信する。
3. `src/session/bidi.ts` の `bidiReadSubscribeResponse()` / `bidiReadFetchResponse()` の catch ブロックに `MalformedTrackError` の処理を追加する。
4. `src/properties.test.ts` に `decodeProperties()` の Mandatory Track Property 検出テストを追加する（境界値テスト含む）。
5. `src/session/bidi.test.ts` に SUBSCRIBE_OK / FETCH_OK 受信時のキャンセル動作テストを追加する。

## reopened にする理由

polish-issue による磨き上げが完了したため。仕様引用の検証・設計方針の確定・完了条件の具体化を実施済み。
