# REQUEST_ERROR の retryInterval と redirect を一部の経路で捨てている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
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

{未着手}
