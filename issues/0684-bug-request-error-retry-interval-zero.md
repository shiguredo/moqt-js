# REQUEST_ERROR の Retry Interval が常に 0 で送られ再試行可能であることを伝えられない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-request-error-retry-interval-zero
- Polished: 2026-10-25

## 目的

draft-ietf-moq-transport-22 §9.4.2 は REQUEST_ERROR の Retry Interval を「要求を再送するまでの最小時間 (ミリ秒) + 1」と定め、「値が 0 なら要求を再試行すべきでない (SHOULD NOT)」「同じパラメータで後から再試行できるなら送信側は 0 以外の Retry Interval を載せる」「1 は即座に再試行してよい」と定める。§12.3 は EXCESSIVE_LOAD について「送信側は再試行できる時期を Retry Interval で示す SHOULD」、UNAUTHORIZED について「認可トークンがまだ有効でない場合は再試行できるかもしれない」と定める。

ライブラリは REQUEST_ERROR を送る 2 つのヘルパーで Retry Interval を `0n` に固定しており、呼び出し側が値を指定する手段が無い。0 は「そのままでは再試行しない」の意味なので、再試行可能な失敗を再試行可能としてピアへ伝えられない。closed/0645 の「残した課題」にも「送信側 (`bidiSendRequestError` / `incomingSendRequestErrorAndClose`) は常に Retry Interval 0 を送るため、再試行可能であることをピアへ伝えない (§9.4.2 の SHOULD。受信側の本 issue とは別の論点)」と記録されている。

## 現状

- `src/session/bidi.ts` の `bidiSendRequestError` は `encodeRequestErrorPayload` に `retryInterval: 0n` を固定で渡す。引数は `session` / `requestId` / `errorCode` / `reasonPhrase` の 4 つで、呼び出し側が間隔を渡す余地が無い
- `bidiSendRequestError` の呼び出しは 6 箇所である。`bidiPreflightRequestUpdate` の GOING_AWAY、`bidiHandlePublishRequestUpdate` の GOING_AWAY と INVALID_FILTER、`bidiHandleRequestUpdateMessage` の INVALID_FILTER、`respondToPublishRequestUpdate` の INTERNAL_ERROR (publisher 不在) と NOT_SUPPORTED (fill fetch 非対応) である
- `src/session/incoming.ts` の `incomingSendRequestErrorAndClose` も `retryInterval: 0n` を固定で渡す。引数は `stream` / `errorCode` / `reasonPhrase` の 3 つである
- `incomingSendRequestErrorAndClose` の呼び出しは 6 箇所である。`src/session/incoming.ts` の `incomingHandleFirstBidiMessage` の DOES_NOT_EXIST と NOT_SUPPORTED、`src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` の UNSUPPORTED_EXTENSION / DOES_NOT_EXIST / UNINTERESTED (2 箇所) である
- 上記 12 箇所は「同じパラメータで再試行しても同じ結果になる」ものがほとんどであり、0 を載せること自体は §9.4.2 に照らして妥当である。問題は値の是非ではなく、§12.3 が再試行の時期を示す SHOULD を置く失敗 (EXCESSIVE_LOAD など) を載せる手段が無いことである
- 送信ヘルパーが送る REQUEST_ERROR の Retry Interval を assert しているテストは無い。`retryInterval` を assert している既存テストは受信経路 (`src/session/bidiResponseUncoveredBranches.test.ts` / `src/session/bidiReadRequestStreamMessages.test.ts` / `src/session.test.ts` / `src/session/namespaceLoops.test.ts` など) と、
  `encodeRequestErrorPayload` のラウンドトリップ (`src/message/session.prop.ts`) だけである
- `src/session/incoming.test.ts` の `incomingSendRequestErrorAndClose: REQUEST_ERROR を書き込み、FIN で閉じ、受信方向をキャンセルする` は送信されたメッセージを `decodeRequestErrorPayload` で復号し、復号した payload では errorCode と reasonPhrase だけを assert している
- `src/message/session.ts` の `encodeRequestErrorPayload` は `retryInterval: bigint` を受け取って `encodeVarint` で符号化する。値の意味付けは行わず、`src/varint.ts` の `encodeVarint` が負値を `negative value not allowed` で拒否する
- `src/error.ts` の `RequestError` クラスの `retryInterval` は受信した値を保持するフィールドであり、送信側の API とは繋がっていない。なお、`encodeRequestErrorPayload` が受け取る `RequestError` は `src/message/session.ts` のメッセージ型であり、`src/error.ts` のクラスとは別である

## 設計方針

- `src/session/bidi.ts` の `bidiSendRequestError` と `src/session/incoming.ts` の `incomingSendRequestErrorAndClose` に省略可能な `retryInterval: bigint` を追加し、既定値を `0n` にする。既定値は §9.4.2 の「再試行しない」であり、既存 12 箇所の呼び出しは引数を省略して送信内容を変えない
- 受け取った値をそのまま `encodeRequestErrorPayload` に渡す。ミリ秒 + 1 への変換や丸めはしない。ライブラリは生値を扱い、値の意味付けと決定は呼び出し側の責務にする (closed/0645 が受信側で採った方針と同じ)
- 引数は既存の引数の後ろに置く。既存 12 箇所は省略したままとする (shiguredo-typescript の「後方互換性は考慮しないこと」に照らし、互換性のための特別扱いではなく、既定値による単純化として扱う)
- 値は 0 以上の `bigint` とし、負値は `encodeVarint` の既存の検証で拒否される。`bidiSendRequestError` は `encodeRequestErrorPayload` の例外をそのまま伝播し、`incomingSendRequestErrorAndClose` は既存の catch で例外を吸収して何も送らない (この非対称は既存挙動であり、本 issue では変えない)
- ライブラリは自動での再試行も再試行間隔の算出もしない。JSDoc に §9.4.2 の意味 (ミリ秒 + 1 の生値 / 0 は再試行しない / 1 は即座に再試行) と §12.3 の EXCESSIVE_LOAD の SHOULD を書く。あわせて、これらが draft-ietf-moq-transport-22 由来であり将来変更される可能性があることを書く
- テストは送信メッセージを復号して検証する既存の形に合わせる。`src/session/incoming.test.ts` に「指定した値が Retry Interval として載る」と「省略時は 0 が載る」を追加する。
  `bidiSendRequestError` はモジュール外から呼べない非公開関数であり、既存 12 箇所はすべて省略するため、bidi 側は `src/session/bidiPublishRequestUpdateConditions.test.ts` の INVALID_FILTER 応答を復号する既存テストに「省略時は 0 が載る」の assert を 1 つ足す。
  指定値の符号化は `incomingSendRequestErrorAndClose` 側で確認し、`encodeRequestErrorPayload` の任意値のラウンドトリップは `src/message/session.prop.ts` の既存 PBT が担保する
- 対象は `src/session/bidi.ts` / `src/session/incoming.ts` / `src/session/incoming.test.ts` / `src/session/bidiPublishRequestUpdateConditions.test.ts` とする。`CHANGES.md` は CODEBASE.md の「MOQT RFC ドラフト中の特別ルール」により更新しない (ルールと実績の矛盾は 0861 で扱う)

## 完了条件

- `bidiSendRequestError` と `incomingSendRequestErrorAndClose` が再試行間隔を引数で受け取れる
- `incomingSendRequestErrorAndClose` に指定した値 (0 / 1 / 60000 など) が REQUEST_ERROR の Retry Interval としてそのまま符号化され、送信されたメッセージを復号して確認できる
- `bidiSendRequestError` の既存呼び出しは省略時の既定 0 が REQUEST_ERROR の Retry Interval として符号化され、送信されたメッセージを復号して確認できる
- 省略した場合の既定が 0 であり、既存 12 箇所の呼び出しの送信内容が変わらない
- ミリ秒 + 1 などの変換をライブラリが行わない
- 負値を渡した場合、`encodeVarint` が `negative value not allowed` で拒否する (既存の検証)。`bidiSendRequestError` は例外を伝播し、`incomingSendRequestErrorAndClose` は既存の catch で吸収して何も送らない
- JSDoc に §9.4.2 の Retry Interval の意味、§12.3 の EXCESSIVE_LOAD の SHOULD、draft-ietf-moq-transport-22 由来で将来変更される可能性があることが書かれている
- 送信側の Retry Interval を検証するテストが `src/session/incoming.test.ts` と `src/session/bidiPublishRequestUpdateConditions.test.ts` に追加される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-22 §9.4.2 (REQUEST_ERROR Message Format。Retry Interval はミリ秒 + 1、0 は再試行しない、1 は即座に再試行) / §12.3 (Request Error Codes。EXCESSIVE_LOAD の SHOULD / UNAUTHORIZED / REDIRECT の 0 の扱い)
- closed/0645 (受信側の `retryInterval` / `redirect` の伝搬。本 issue はその「残した課題」) / 0662 (bidi の状態機械の PBT) / 0861 (CHANGES.md を更新しないルールと実績の矛盾)
- `src/session/bidi.ts` の `bidiSendRequestError`、`src/session/incoming.ts` の `incomingSendRequestErrorAndClose`、`src/message/session.ts` の `encodeRequestErrorPayload`、`src/varint.ts` の `encodeVarint`、`src/error.ts` の `RequestError`

## 解決方法

{未着手}
