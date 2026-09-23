# REQUEST_ERROR の retryInterval と redirect を一部の経路で捨てている

- Created: 2026-09-21
- Completed: 2026-09-24
- Branch: feature/fix-request-error-redirect-fields
- Polished: 2026-09-21

## 目的

REQUEST_ERROR は Retry Interval と任意の Redirect を持ち、REDIRECT コードでは受け取った側が新しいセッションを張って再試行する SHOULD が定められている。これらのフィールドを捨てると、アプリは再試行の間隔も転送先も知れない。

## 現状

- `src/error.ts` の `RequestError` は `retryInterval` と `redirect` を保持できる
- `decodeRequestErrorPayload` の戻り値から両方を載せている経路は、`src/session/bidi.ts` の PUBLISH 応答の `handleRequestError`、`src/session/namespaceLoops.ts` の `decodeRequestErrorToRequestError` (namespace 系の初期 REQUEST_ERROR と確立後の更新失敗) と publication ループの `onRequestError` である
- 載せていない経路は次のとおり
  - `src/session/bidi.ts` の SUBSCRIBE 応答の `handleRequestError`
  - `src/session/bidi.ts` の FETCH 応答の `handleRequestError`
  - `src/session/bidi.ts` の TRACK_STATUS 応答の `handleRequestError`
  - `src/session/bidi.ts` の `bidiProcessRequestStreamMessages` にある確立後の REQUEST_ERROR 分岐 (REQUEST_UPDATE の失敗として複数の pending を reject する)
  - `src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop` にある REQUEST_ERROR 分岐
- `src/session/incomingPublish.ts` には GOAWAY を通知する `RequestError` の構築もあるが、GOAWAY 自体がこの 2 フィールドを持たないため対象外である
- closed/0186 と `CHANGES.md` は「全 8 箇所 (0186 の本文では全 9 箇所) の REQUEST_ERROR 受信処理で retryInterval / redirect を伝搬する」と記録しているが、上の 5 経路では落ちている

## 設計方針

- 上の 5 経路すべてで `decoded.retryInterval` と `decoded.redirect` を `RequestError` に渡す。PUBLISH 応答経路と同じ形に揃える
- `retryInterval` はデコード済みの生値をそのまま保持する (§9.4.2 の「Retry Interval はミリ秒 + 1」。-1 などの変換をしない)。0 は「再試行しない」の意味を持つ値としてアプリへ渡す (REDIRECT のときは §12.3 により、0 でも Redirect の追従を妨げない)
- ライブラリは受け取った値をアプリへ渡すだけにし、自動での再試行や Redirect の追従は行わない (再試行の判断はアプリに委ねる)
- 確立後の REQUEST_ERROR は 1 通で複数の pending REQUEST_UPDATE を失敗させる。`rejectPendingRequestUpdates` は既に同じ `RequestError` インスタンスを全 pending に共有して reject しているため、この形を変えずに両フィールドを載せる
- REQUEST_UPDATE への REDIRECT は §12.3 の適用先一覧に無いが、デコーダは REDIRECT コードのときだけ Redirect を復号するため、受信した値はそのまま保持する (受信側で捨てない)
- テストは経路ごとに追加する。応答 3 経路 (SUBSCRIBE / FETCH / TRACK_STATUS) は `src/session/bidiResponseUncoveredBranches.test.ts`、確立後は `src/session/bidiReadRequestStreamMessages.test.ts`、受信 PUBLISH は `src/session.test.ts` の受信 PUBLISH 後続ループのハーネスに置く。PUBLISH 応答は `src/session/bidiResponseUncoveredBranches.test.ts` の既存テストで検証済みのため二重に追加しない

## 完了条件

- 対象 5 経路すべてで `RequestError.retryInterval` と `RequestError.redirect` が設定される (デコード済みの生値をそのまま保持する)
- REDIRECT 以外のエラーコードに Redirect が付いたメッセージは、現行どおりデコーダが ProtocolViolationError で拒否する (退行確認)
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §9.4.2 (REQUEST_ERROR の形式。Retry Interval は「ミリ秒 + 1」で 0 は再試行しない、Redirect は REDIRECT のときだけ存在する)
- draft-ietf-moq-transport-21 §9.4.1 (Redirect の構造)
- draft-ietf-moq-transport-21 §12.3 (REDIRECT。要求側は新しいセッションを張り Redirect target で再試行する SHOULD)

## 解決方法

- `src/session/bidi.ts` に `buildRequestErrorFromDecoded(decoded)` を追加し、デコード済み REQUEST_ERROR から `RequestError` を組み立てる処理 (Reason Phrase の既定文言 / `normalizeRequestErrorCode` / Retry Interval の生値 / Redirect の写像) を 1 箇所に集約した。`RequestError` を組み立てるのはこの関数と、フィールドを持たない GOAWAY 由来の 2 箇所だけになる
- フィールドを捨てていた 5 経路をこの関数に寄せた。SUBSCRIBE 応答 / FETCH 応答 / TRACK_STATUS 応答 (`handleRequestError`)、確立後の REQUEST_ERROR (`bidiProcessRequestStreamMessages`)、受信 PUBLISH の REQUEST_ERROR (`incomingPublishRunStreamSubLoop`)。確立後は coalescing で複数の pending を失敗させる場合も同じインスタンスを共有する (テストで固定)
- namespace 系 (`decodeRequestErrorToRequestError`) も同じ関数へ委譲した。PUBLISH_NAMESPACE の初回応答が §9.4.1 の namespace-scoped Redirect の検証 (Track Name は空が MUST。非空は PROTOCOL_VIOLATION) を通っていなかったため、SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS と同じ検証を通るようにした。あわせて Reason Phrase が空のときのメッセージも他経路と同じ固定文言に揃った
- ライブラリは受け取った値をアプリへ渡すだけで、自動での再試行や Redirect の追従は行わない (従来どおり。再試行はアプリが `connect()` から行う)
- 公開型に意味を書いた。`RequestError.retryInterval` (ミリ秒 + 1 の生値、0 は「そのままでは再試行しない」で Redirect の追従は妨げない) / `RequestError.redirect` (REDIRECT のときだけ存在) / `RedirectInfo` の各フィールドに §9.4.1 / §9.4.2 / §12.3 を引用した JSDoc を追加し、`type RedirectInfo` を `src/index.ts` の公開再エクスポートに加えた
- `CHANGES.md` の `## develop` 先頭に `[FIX]` を追記した

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2557 tests) が通る
- テストは、応答 3 経路 (SUBSCRIBE / FETCH / TRACK_STATUS)・確立後・受信 PUBLISH・namespace 系 3 種 (PUBLISH_NAMESPACE 初回の非空 Track Name 検証 / PUBLISH_NAMESPACE 初回のフィールド保持 / namespace・tracks の初期と確立後) を追加し、既存の SUBSCRIBE テストに非 REDIRECT コードでは Redirect が付かないことの assert を足した
- 変異テストで、ヘルパーから Retry Interval / Redirect を落とす・固定文言を変える・namespace/tracks の各呼び出し箇所を 2 引数構築に戻す・Track Name 検証を無効化する、のいずれでも対応するテストが失敗することを確認した (レビュアーは独立に 19 種を実施)

## 残した課題

- `type RedirectInfo` の公開再エクスポートは、リポジトリ内に利用者がいないためテストでも `tsc` でも削除を検出できない (公開型再エクスポート全体に共通する性質)
- 公開 API (`session.subscribe()` 等) 経由の reject で 2 フィールドが届くことの end-to-end テストは無い (確立後経路は実 `SubscriberImpl.update()` の既存テストが担保)
- `retryInterval` の「undefined はライブラリ生成のエラーだけ」は JSDoc の記述のみで、型 (`bigint | undefined`) では表現していない
- 送信側 (`bidiSendRequestError` / `incomingSendRequestErrorAndClose`) は常に Retry Interval 0 を送るため、再試行可能であることをピアへ伝えない (§9.4.2 の SHOULD。受信側の本 issue とは別の論点)
