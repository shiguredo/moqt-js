# REQUEST_ERROR の Retry Interval が常に 0 で送られ再試行可能であることを伝えられない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-error-retry-interval-zero
- Polished: 2026-09-24

## 目的

draft-ietf-moq-transport-21 §9.4.2 は REQUEST_ERROR の Retry Interval を「要求を再送するまでの最小時間 (ミリ秒) + 1」と定め、「値が 0 なら要求を再試行すべきでない (SHOULD NOT)」「同じパラメータで後から再試行できるなら送信側は 0 以外の Retry Interval を載せる」「1 は即座に再試行してよい」と定める。§12.3 は EXCESSIVE_LOAD について「送信側は再試行できる時期を Retry Interval で示す SHOULD」、UNAUTHORIZED について「認可トークンがまだ有効でない場合は再試行できるかもしれない」と定める。

ライブラリは REQUEST_ERROR を送る 2 つのヘルパーで Retry Interval を `0n` に固定しており、呼び出し側が値を指定する手段が無い。0 は「そのままでは再試行しない」の意味なので、再試行可能な失敗を再試行可能としてピアへ伝えられない。closed/0645 の「残した課題」にも「送信側 (`bidiSendRequestError` / `incomingSendRequestErrorAndClose`) は常に Retry Interval 0 を送るため、再試行可能であることをピアへ伝えない (§9.4.2 の SHOULD。受信側の本 issue とは別の論点)」と記録されている。

## 現状

- `src/session/bidi.ts` の `bidiSendRequestError` (1511-1527 行目) は `encodeRequestErrorPayload` に `retryInterval: 0n` を固定で渡す (1520 行目)。引数は `session` / `requestId` / `errorCode` / `reasonPhrase` の 4 つで、呼び出し側が間隔を渡す余地が無い
- `bidiSendRequestError` の呼び出しは 6 箇所である。`bidiReadRequestStreamMessages` の GOING_AWAY (1860 行目) と INVALID_FILTER (2059 行目)、`bidiHandlePublishRequestUpdate` の GOING_AWAY (1987 行目) と INVALID_FILTER (2786 行目)、`respondToPublishRequestUpdate` の INTERNAL_ERROR (2893 行目、publisher 不在) と NOT_SUPPORTED (2912 行目、fill fetch 非対応)
- `src/session/incoming.ts` の `incomingSendRequestErrorAndClose` (100-138 行目) も `retryInterval: 0n` を固定で渡す (111 行目)。引数は `stream` / `errorCode` / `reasonPhrase` の 3 つである
- `incomingSendRequestErrorAndClose` の呼び出しは 6 箇所である。`src/session/incoming.ts` の DOES_NOT_EXIST (262 行目) と NOT_SUPPORTED (272 行目)、`src/session/incomingPublish.ts` の UNSUPPORTED_EXTENSION (605 行目) / DOES_NOT_EXIST (663 行目) / UNINTERESTED (687 行目と 730 行目)
- 上記 12 箇所は「同じパラメータで再試行しても同じ結果になる」ものがほとんどであり、0 を載せること自体は §9.4.2 に照らして妥当である。問題は値の是非ではなく、§12.3 が再試行の時期を示す SHOULD を置く失敗 (EXCESSIVE_LOAD など) を載せる手段が無いことである
- 送信する REQUEST_ERROR の Retry Interval を assert しているテストは無い。`retryInterval` を assert しているテストは受信側だけである (`src/session/bidiResponseUncoveredBranches.test.ts` / `src/session/bidiReadRequestStreamMessages.test.ts` / `src/session.test.ts` など)
- `src/session/incoming.test.ts` の `incomingSendRequestErrorAndClose: REQUEST_ERROR を書き込み、FIN で閉じ、受信方向をキャンセルする` (53 行目) は送信されたメッセージを `decodeRequestErrorPayload` で復号し、errorCode と reasonPhrase だけを assert している
- `src/message/session.ts` の `encodeRequestErrorPayload` (373 行目) は `retryInterval: bigint` を受け取って `encodeVarint` で符号化する。値の意味付けは行わず、`src/varint.ts` の `encodeVarint` (76 行目) が負値を `negative value not allowed` で拒否する
- `src/error.ts` の `RequestError.retryInterval` (248 行目) は受信した値を保持するフィールドであり、送信側の API とは繋がっていない

## 設計方針

- `src/session/bidi.ts` の `bidiSendRequestError` と `src/session/incoming.ts` の `incomingSendRequestErrorAndClose` に省略可能な `retryInterval: bigint` を追加し、既定値を `0n` にする。既定値は §9.4.2 の「再試行しない」であり、既存 12 箇所の呼び出しの送信内容は変わらない
- 受け取った値をそのまま `encodeRequestErrorPayload` に渡す。ミリ秒 + 1 への変換や丸めはしない。ライブラリは生値を扱い、値の意味付けと決定は呼び出し側の責務にする (closed/0645 が受信側で採った方針と同じ)
- 引数は既存の引数の後ろに置き、呼び出し側の互換性を壊さない。値は 0 以上の `bigint` とし、負値は `encodeVarint` の既存の検証で拒否される
- ライブラリは自動での再試行も再試行間隔の算出もしない。JSDoc に §9.4.2 の意味 (ミリ秒 + 1 の生値 / 0 は再試行しない / 1 は即座に再試行) と §12.3 の EXCESSIVE_LOAD の SHOULD を書く
- テストは送信メッセージを復号して検証する既存の形に合わせる。`src/session/incoming.test.ts` に「指定した値が Retry Interval として載る」と「省略時は 0 が載る」を追加し、`bidiSendRequestError` 側は送信メッセージを復号している既存テスト (`src/session/bidiPublishRequestUpdateConditions.test.ts` など) に 1 件足す
- 対象は `src/session/bidi.ts` / `src/session/incoming.ts` / `src/session/incoming.test.ts` / `src/session/bidi*.test.ts` / `CHANGES.md` とする
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- `bidiSendRequestError` と `incomingSendRequestErrorAndClose` が再試行間隔を引数で受け取れる
- 指定した値 (0 / 1 / 60000 など) が REQUEST_ERROR の Retry Interval としてそのまま符号化され、送信されたメッセージを復号して確認できる
- 省略した場合の既定が 0 であり、既存 12 箇所の呼び出しの送信内容が変わらない
- ミリ秒 + 1 などの変換をライブラリが行わない
- 負値を渡した場合は `encodeVarint` の検証で拒否される (既存の挙動)
- JSDoc に §9.4.2 の Retry Interval の意味と §12.3 の EXCESSIVE_LOAD の SHOULD が書かれている
- 送信側の Retry Interval を固定するテストが `src/session/incoming.test.ts` と bidi 側の送信テストに追加される
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.4.2 (REQUEST_ERROR Message Format。Retry Interval はミリ秒 + 1、0 は再試行しない、1 は即座に再試行) / §12.3 (Request Error Codes。EXCESSIVE_LOAD の SHOULD / UNAUTHORIZED / REDIRECT の 0 の扱い)
- closed/0645 (受信側の `retryInterval` / `redirect` の伝搬。本 issue はその「残した課題」) / 0662 (bidi の状態機械の PBT)
- `src/session/bidi.ts` の `bidiSendRequestError`、`src/session/incoming.ts` の `incomingSendRequestErrorAndClose`、`src/message/session.ts` の `encodeRequestErrorPayload`、`src/varint.ts` の `encodeVarint`、`src/error.ts` の `RequestError`

## 解決方法

{未着手}
