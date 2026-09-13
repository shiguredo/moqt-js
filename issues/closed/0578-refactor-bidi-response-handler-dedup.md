# bidiReadResponse のハンドラ表から経路共通の後始末と reject / close の定型を既定実装に抽出する

- Created: 2026-09-12
- Completed: 2026-09-14
- Branch: feature/refactor-bidi-response-handler-dedup
- Polished: {YYYY-MM-DD}

## 目的

`src/session/bidi.ts` の `bidiReadResponse` のハンドラ表には、経路名を除けば同一の処理が残っている。`handleCloseError` / `handleError` / `handleUnexpected` の 4 経路分は約 90 行の重複であり、1 件の修正が 4 箇所の保守になる。削除集合・エラー文言ラベル・成功後処理をパラメータ化した既定実装に集約し、経路差を宣言的に表現する。

## 現状

- `handleCloseError` / `handleError` / `handleUnexpected` は 4 経路 (PUBLISH / SUBSCRIBE / FETCH / TRACK_STATUS) でほぼ同一の処理を持ち、差分は削除する Map と `fireFetcherReadyCallbacks` の有無、リクエスト種別ラベルのみである。
- `handleOk` / `handleRequestError` / `handleGoaway` / `handleMalformedTrack` は経路差が大きく、現行どおりハンドラに残すのが妥当である。
- 削除集合・reject と close の順序・同一 `SessionError` オブジェクト性は全経路共通の不変条件であり、既定実装でも維持する必要がある。

## 設計方針

1. ハンドラ表に `cleanup` (経路別の削除と `fireFetcherReadyCallbacks`) と `requestLabel` (リクエスト種別名) を追加し、`handleCloseError` / `handleError` / `handleUnexpected` を既定実装として提供する。経路が上書きする場合のみハンドラを指定する。
2. 既定実装は「cleanup → pending.reject → closeWithError」の順序を守る。
3. 既存のエラー文言・削除集合・順序・同一オブジェクト性を変えない。
4. 後続の 0572 / 0575 が malformed 系のハンドラを追加・変更するため、両者より後に実施する。

## 完了条件

- 経路共通の定型が既定実装に集約され、経路差が `cleanup` と `requestLabel` で表現されていること。
- 削除集合・reject と close の順序・同一 `SessionError` オブジェクト性・`handleMalformedTrack` の有無が全経路で不変であること。
- 既存テストが無変更で全て通り、`vp check` / `tsc --noEmit` / `vp test run` が通ること。
- `CHANGES.md` の `### misc` に `[UPDATE]` を追加すること。

## 関連

- `bidiReadResponse` / `BidiResponseHandlers` (`src/session/bidi.ts`)
- `issues/closed/0498-refactor-bidi-namespace-dedup.md` (共通リーダの導入)
- `issues/0572-bug-empty-message-track-properties-close.md` / `issues/0575-bug-track-status-malformed-handling.md` (malformed 系の先行 issue)

## 解決方法

実装した。issue 本文の `bidiReadResponse` は 0580 で `bidiDispatchResponse` へ改名済みである。

### ハンドラ表の変更

`BidiResponseHandlers` に次の 2 つを追加し、`handleUnexpected` / `handleCloseError` / `handleError` を任意にした。

- `cleanup(session, requestId)`: 経路別の削除と `fireFetcherReadyCallbacks`
- `requestLabel`: エラーメッセージに使うリクエスト種別名 (`"PUBLISH"` / `"SUBSCRIBE"` / `"FETCH"` / `"TRACK_STATUS"`)

4 経路それぞれの `cleanup` は次のとおりで、従来の各ハンドラが持っていた削除集合と `fireFetcherReadyCallbacks` の有無をそのまま移した。

- PUBLISH: `pendingPublish` / `requestStreams`
- SUBSCRIBE: `pendingSubscribe` / `requestStreams` / `fillFetchTargets`
- FETCH: `pendingFetch` / `requestStreams` / `fireFetcherReadyCallbacks`
- TRACK_STATUS: `pendingTrackStatus` / `requestStreams`

### 既定実装

`defaultBidiHandleUnexpected` / `defaultBidiHandleCloseError` / `defaultBidiHandleError` を追加し、`bidiDispatchResponse` 側で `handlers.X ?? defaultBidiHandleX(handlers)` として解決する。4 経路はいずれも上書きしていないため、12 個の重複定義 (約 90 行) が削除された。経路固有の後始末が必要になった場合はハンドラを指定して上書きできる。

- `handleCloseError`: cleanup → `pending.reject(error)` → `session.closeWithError(error)` (同一オブジェクト)
- `handleError`: cleanup → `pending.reject(error instanceof Error ? error : new Error(String(error)))`
- `handleUnexpected`: cleanup → PUBLISH_STATE_NOTIFY なら PROTOCOL_VIOLATION の `SessionError` を reject して close、それ以外は `unexpected response type ${type} for ${label} request` を reject (close しない)

### 型の制約

既定実装は `pending.reject` を呼ぶため、`TPending` を新設の `BidiPendingRejectable` (`reject: (error: Error) => void`) で制約した。4 経路の pending 型はいずれもこの面を満たす。

### 検証

- 既存テスト 2,136 件が無変更で全通過 (削除集合・エラー文言・順序・同一オブジェクト性が不変であることの裏付け)
- `vp check` / `tsc --noEmit` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
