# REQUEST_ERROR の retryInterval と redirect を一部の経路で捨てている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-error-redirect-fields
- Polished: {YYYY-MM-DD}

## 目的

REQUEST_ERROR は Retry Interval と任意の Redirect を持ち、REDIRECT コードでは受け取った側が新しいセッションを張って再試行する SHOULD が定められている。これらのフィールドを捨てると、アプリは再試行の間隔も転送先も知れない。

## 現状

- `src/error.ts` の `RequestError` は `retryInterval` と `redirect` を保持できる
- `decodeRequestErrorPayload` の戻り値から両方を載せている経路は、`src/session/bidi.ts` の PUBLISH 応答の `handleRequestError` と、`src/session/namespaceLoops.ts` の `decodeRequestErrorToRequestError` および `onRequestError` である
- 載せていない経路は次のとおり
  - `src/session/bidi.ts` の SUBSCRIBE 応答の `handleRequestError`
  - `src/session/bidi.ts` の FETCH 応答の `handleRequestError`
  - `src/session/bidi.ts` の TRACK_STATUS 応答の `handleRequestError`
  - `src/session/bidi.ts` の `bidiProcessRequestStreamMessages` にある確立後の REQUEST_ERROR 分岐
  - `src/session/incomingPublish.ts` の `incomingPublishRunStreamSubLoop` にある REQUEST_ERROR 分岐

## 設計方針

- 上記の経路すべてで `decoded.retryInterval` と `decoded.redirect` を `RequestError` に渡す。PUBLISH 応答経路と同じ形に揃える
- 確立後の REQUEST_ERROR は REQUEST_UPDATE の失敗として複数の pending を reject する。同じ `RequestError` インスタンスを共有してよいかを含め、既存の reject 経路に合わせる
- 経路ごとにテストを追加し、`retryInterval` と `redirect` が保持されることを固定する

## 完了条件

- 対象経路すべてで `RequestError.retryInterval` と `RequestError.redirect` が設定される
- REDIRECT 以外のエラーコードでは `redirect` が undefined のままである
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §9.4.2 (REQUEST_ERROR の形式。Retry Interval と任意の Redirect)
- draft-ietf-moq-transport-21 §9.4.1 (Redirect の構造)
- draft-ietf-moq-transport-21 §12.3 (REDIRECT。要求側は新しいセッションを張り Redirect target で再試行する SHOULD)

## 解決方法

{未着手}
