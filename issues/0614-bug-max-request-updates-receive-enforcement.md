# MAX_REQUEST_UPDATES の受信側強制が無い

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-max-request-updates-receive
- Polished: 2026-09-15
- Updated: 2026-09-16

## 目的

draft-ietf-moq-transport-21 §9.1.7 は、ある request stream 上で既に MAX_REQUEST_UPDATES 件の未応答 REQUEST_UPDATE がある状態でさらに受信した場合、TOO_MANY_REQUEST_UPDATES でセッションを閉じる MUST を定める。送信側の遵守は実装済みだが受信側の強制がなく、自分が広告した上限を超えてパイプラインされても通常どおり応答してしまう。

`ConnectOptions.maxRequestUpdates` で SETUP に広告できるようになったため、「広告しないので受信側制限は不要」という以前の前提は成立しなくなっている。

## 現状

- `ConnectOptions.maxRequestUpdates` (`src/session.ts`) は `createSetup` へ渡して SETUP に広告するだけで、ローカル上限として保持するフィールドがない
- 比較対象: `localMaxFilterRanges` と `localMaxAuthTokenCacheSize` は自 endpoint が広告した上限として保持し、受信検証に使っている
- `SessionErrorCode.TOO_MANY_REQUEST_UPDATES` (`src/error.ts`) は定義されているが送出箇所がない
- 受信 REQUEST_UPDATE の 2 経路は `bidiHandlePublishRequestUpdate` (受信 PUBLISH ストリーム。呼び出し元は `SessionImpl.runPublishStreamSubLoop`) と `bidiReadRequestStreamMessages` の `MessageType.REQUEST_UPDATE` ケース (送信 PUBLISH ストリーム) である。いずれもストリーム単位の未応答数を数えていない
- 両経路とも、1 回の read が返したメッセージ列 (`ControlStreamReader.feed` の戻り値) を 1 通ずつ順に処理し、応答の書き込みを `await` してから次のメッセージへ進む。この構造のまま「受信時に加算し、応答の書き込み完了で減算する」カウンタにすると、未応答数は常に 0 か 1 にしかならない (1 回の read に複数の REQUEST_UPDATE が含まれても、2 通目の加算より前に 1 通目の減算が終わる)。上限 N (N>0) に到達しないため超過を検出できず、§9.1.7 が認める「即時処理では pipelining を検出できない」状態のままになる ("An implementation that processes and responds to a REQUEST_UPDATE immediately might not detect when a peer has pipelined messages exceeding its limit")
- 送信側は `bidiSendRequestUpdate` でピア上限を超える送信を拒否しており、送受信で非対称

draft-ietf-moq-transport-21 §9.1.7:

> If an endpoint receives a REQUEST_UPDATE on a stream that already has MAX_REQUEST_UPDATES outstanding REQUEST_UPDATEs, it MUST close the session with TOO_MANY_REQUEST_UPDATES.

## 設計方針

- 広告値の既定は 0 (無制限。§9.1.7)。0 のときは強制しない
- 受信 REQUEST_UPDATE をストリーム単位の未応答数として数え、数えた後の件数が上限を超えるなら TOO_MANY_REQUEST_UPDATES で閉じる
- 未応答数の減算は 1 通ごとではなく、1 回の read で得たメッセージ列を処理し終えた時点でまとめて行う。1 通ごとに減算すると、応答の書き込みを `await` してから次のメッセージへ進む構造のため未応答数が常に 0 か 1 にしかならず、同じ read に含まれる 2 通目以降を検出できない
- §9.5 が認める coalescing を併用してもよい。併用する場合、§9.5 は成功した更新に 1 通ずつ REQUEST_OK を返す MUST を維持したまま処理の集約だけを認め、REQUEST_ERROR への集約を認めるのは複数の失敗を 1 通にまとめるときに限る。この区別どおりに扱う

### 確定事項

- 広告値は `SessionImpl` の `localMaxRequestUpdates` に保持する。`localMaxFilterRanges` / `localMaxAuthTokenCacheSize` と同じ位置 (`src/session.ts` のフィールド宣言) に置き、`initialize()` で `options?.maxRequestUpdates ?? 0` を代入する。未広告は 0 (無制限。§9.1.7「A value of 0 means the endpoint does not limit REQUEST_UPDATE concurrency.」)。`MAX_FILTER_RANGES` の 0 が「受信拒否」なのとは意味が逆であるため、受信側のガードで 0 を拒否として扱わない。`BidiSessionInternal` (`src/session/bidi.ts`) に `readonly localMaxRequestUpdates: number` を加えて両経路から読めるようにする
- 未応答数は `SessionImpl` の `receivedRequestUpdateCounts` (`Map<bigint, number>`、キーは request stream の Request ID) に保持する。§6.4.2.1 は「Each SUBSCRIBE, PUBLISH, FETCH, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS, PUBLISH_NAMESPACE, REQUEST_UPDATE, and TRACK_STATUS message consumes a Request ID.」と定め、REQUEST_UPDATE は更新ごとに新しい Request ID を消費する。したがってメッセージの Request ID は対象リクエストを識別せず、受信側の既存コードも「更新は新規 ID を消費するため、ストリーム紐付け ID との一致照合は行わない」としている。キーには各受信ループが持つストリームの Request ID (`bidiReadRequestStreamMessages` と `bidiHandlePublishRequestUpdate` の `requestId`) を使う。`BidiSessionInternal` に `readonly receivedRequestUpdateCounts: Map<bigint, number>` として公開し、2 経路が同じフィールドを更新する
- 加算は 1 通の処理の先頭、`decodeRequestUpdatePayload` の直後で `await` を挟む前に行う。受信した時点で未応答数に数える
- 判定は加算後の件数で行い、`localMaxRequestUpdates > 0` かつ件数が上限を超えるとき (`件数 > localMaxRequestUpdates`) に `SessionError(..., SessionErrorCode.TOO_MANY_REQUEST_UPDATES)` を `closeWithError` に渡す。§9.1.7 の MUST は「受信時点で既に MAX_REQUEST_UPDATES 件が未応答」を要件とするため、上限と等しいだけでは閉じない (N 件目までは受理し N+1 件目で閉じる)。加算前の件数で判定する形 (`>= localMaxRequestUpdates`) でも同じ意味になるが、どちらか一方に統一する
- 減算は 1 通ごとではなく、1 回の read で得たメッセージ列の処理を終えた時点で行う。両受信ループ (`bidiReadRequestStreamMessages` の `for (const msg of messages)` と `SessionImpl.runPublishStreamSubLoop` の `for (const msg of messages)`) で、その read の先頭に当該ストリームの未応答数を記録し、メッセージ列の処理を包む `finally` で記録した値へ戻す (この read で加算した件数分の減算と等価)。応答の書き込みを `await` してから次のメッセージへ進む構造のため、1 通ごとに減算すると未応答数は常に 0 か 1 にしかならず N+1 通目を検出できない。チャンク単位の減算なら、同じ read に含まれる REQUEST_UPDATE が受信済み・未応答として同時に立つ
- 応答を送らずに処理を終える経路でも減算は同じ `finally` が担い、分岐ごとに減算の有無を変えない。応答を送らないのは (a) `bidiPreflightRequestUpdate` の subscribe ロールで GOAWAY 受信済みの場合 (REQUEST_UPDATE を無視して読み取りを継続する) と、(b) セッションを閉じる経路 (デコード失敗、不正な Request ID、subscribe ストリームでの想定外 REQUEST_UPDATE、パラメータスコープ違反、`ProtocolViolationError`、AUTHORIZATION TOKEN のデコード不能・重複 Alias・上限超過・未登録 Alias の参照) である。(a) はストリームが継続するため `finally` の減算が必要で、(b) は終了時にカウンタごと破棄されるため減算の結果は問題にならない
- AUTHORIZATION TOKEN の `unknown-alias` は REQUEST_ERROR を送らない。未登録 Alias の参照は Session Termination の `UNKNOWN_AUTH_TOKEN_ALIAS` でセッションを閉じる経路であり、上記 (b) に含まれる。`bidiTerminatePublishSubscriptionWithUpdateFailed` による `PUBLISH_DONE` (`UPDATE_FAILED`) も送らない (セッション終了により購読が終わるため)。したがって本 issue が数える「REQUEST_UPDATE への応答」には現れない
- REQUEST_UPDATE への応答 (REQUEST_OK / REQUEST_ERROR) を送る箇所は 8 つある。内訳は `bidiSendRequestError` の呼び出し 6 箇所と REQUEST_OK の送信 2 箇所である。減算はチャンク単位の 1 箇所に固定するため、この列挙には依存しない (確認用)
  - `bidiSendRequestError` の 6 箇所: `bidiPreflightRequestUpdate` の `GOING_AWAY` (publish ロール)、`bidiHandlePublishRequestUpdate` の `GOING_AWAY` と `INVALID_FILTER`、`bidiReadRequestStreamMessages` の REQUEST_UPDATE ケースの `INVALID_FILTER` / `NOT_SUPPORTED` (fill fetch 非対応) / `INTERNAL_ERROR` (publisher 不在)
  - REQUEST_OK の 2 箇所: `bidiHandlePublishRequestUpdate` の `bidiSendRequestOk`、`bidiReadRequestStreamMessages` の REQUEST_UPDATE ケースの直接書き込み
- 応答送信ヘルパー (`bidiSendRequestError` / `bidiSendRequestOk`) の内部に減算を置かない。上記 (a) のように応答を送らない経路でも減算が必要であり、減算の単位も応答 1 通ではなく 1 回の read で加算した件数であるため、ヘルパー内では単位が合わない
- 書き込み失敗の有無で減算を変えない。`bidiSendRequestMessage` は書き込み失敗を黙殺するが、チャンク単位の減算は書き込みの成否を見ないため失敗時も同じように戻る (セッション終了・ストリーム終了のいずれかであり、以後そのストリームの REQUEST_UPDATE は処理されない)
- 超過を検出した時点で `closeWithError` を呼び、その read に含まれる残りのメッセージの処理を打ち切る。`closeWithError` は throw しないため、`bidiReadRequestStreamMessages` では既存の `SessionErrorCode.PROTOCOL_VIOLATION` の各検出箇所と同じく `return` して読み取りループを抜ける。`bidiHandlePublishRequestUpdate` は戻り値が `void` であり、呼び出し元の `SessionImpl.runPublishStreamSubLoop` が `sessionState !== "connected"` を検査して打ち切る既存の仕組みに乗る。`closeWithError` は `SessionError` のコードを `close()` に渡す既存経路 (`KEY_VALUE_FORMATTING_ERROR` 等) と同じくピアへ伝える
- カウンタはストリーム終了時に破棄する。受信 PUBLISH 経路は受信 PUBLISH 購読ループの呼び出し元 `SessionImpl.handleIncomingBidirectionalStream` の `finally` が呼ぶ `SessionImpl.cleanupIncomingPublish` (`requestStreams` を削除する箇所)、送信 PUBLISH 経路は `bidiReadRequestStreamMessages` の `finally` で削除する (publish ロールでピア FIN を受けた場合、`requestStreams` の削除は `done()` 完了後まで遅延するため、カウンタの削除はその条件分岐の外側で行う)。セッション終了時は `SessionImpl` の終了処理で他の追跡 (`receivedRequestIds` 等) と同じ位置で `clear()` する。掃除しないと、ストリーム終了後に残った件数で以後の REQUEST_UPDATE を誤って超過と判定する
- 減算後に 0 になったエントリは削除し、存在しないエントリへの減算 (0 未満) は行わない
- テストは実ストリームと実 Map で構成した既存のヘルパー (`src/testSupport/bidi.ts`) を使い、モックやスタブを追加しない。上限超過は 1 回の read に N+1 通の REQUEST_UPDATE を含むチャンクを届けて再現する (チャンク単位の減算により、N 通目の応答後も未応答数が残った状態で N+1 通目を判定できる)

## 完了条件

- `SessionImpl.localMaxRequestUpdates` の既定値が 0 で、`initialize({ maxRequestUpdates: N })` で N が保持される
- 上限 N (N>0) を広告した状態で、1 回の read に N+1 通の REQUEST_UPDATE を含むチャンクを届けると、N+1 通目の処理で `SessionErrorCode.TOO_MANY_REQUEST_UPDATES` によりセッションが閉じる。N 通目までは応答が返りセッションは閉じない
- 未広告 (既定 0) では同じチャンクを届けても閉じず、すべての REQUEST_UPDATE に応答する
- 1 回の read のメッセージ列を処理し終えると、その read で加算した件数分が未応答数から戻る。上限以内 (N 通以下) のチャンクを届けて応答を受けてから次のチャンクを届ける限り、閉じない
- 応答を送らずに無視する分岐 (`bidiPreflightRequestUpdate` の subscribe ロールで GOAWAY 受信済み) でも未応答数が残留しない。セッションを閉じる分岐でも残留しない
- ストリーム終了とセッション終了で未応答数が破棄される
- 受信 REQUEST_UPDATE の 2 経路 (`bidiHandlePublishRequestUpdate` / `bidiReadRequestStreamMessages` の REQUEST_UPDATE ケース) の双方で機能する
- `src/session/bidiRequestUpdateScopeAudit.test.ts` に送信 PUBLISH 経路 (`bidiReadRequestStreamMessages` の publish ロール、`createPublishReadTestContext`) の超過と上限内のテストを追加する。超過は `readableController` に N+1 通を連結した 1 チャンクを enqueue して再現する
- `src/session.test.ts` に受信 PUBLISH 経路 (`SessionImpl.runPublishStreamSubLoop`) の超過のテストを追加する。`createIncomingPublishStream` の `extraFrames` に N+1 通を連結した 1 チャンクを渡して再現する
- `src/session/bidiHandlePublishRequestUpdate.test.ts` に、未応答数が上限に達した状態 (実 Map で `receivedRequestUpdateCounts` を組み立て、上限 N は `BidiSessionInternal` では `readonly` のため既存の `localMaxFilterRanges` と同じくテスト側でキャストして `localMaxRequestUpdates` に代入して構成する) での受信が `TOO_MANY_REQUEST_UPDATES` になり、上限未満では閉じないことの単体テストを追加する
- `src/session.test.ts` の既存の SETUP 上限広告テスト (`initialize: SETUP で上限を広告し localMaxFilterRanges を保持する`) に `localMaxRequestUpdates` の既定値と保持の検証を追加する
- `src/testSupport/bidi.ts` の 5 つのセッションオブジェクトリテラル (`createPublishReadTestContext` は必須、他も受信経路を通るテストで使うもの) に `localMaxRequestUpdates: 0` と `receivedRequestUpdateCounts: new Map()` の既定値を追加する (`as unknown as BidiSessionInternal` のキャストのため型では検出されず、実行時に未定義だと落ちる)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.1.7 (MAX_REQUEST_UPDATES)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §12.2 (Session Termination Codes)
- `issues/closed/0338-draft-19-add-max-request-updates.md` (自 endpoint の上限広告を追加した先行 issue。受信側の outstanding カウントと TOO_MANY_REQUEST_UPDATES でのセッション切断を別 issue 送りにしており、本 issue がその後続)
- `issues/0618-change-receive-response-conformance.md` (GOAWAY 受信後に subscribe ロールで届いた REQUEST_UPDATE を無視する現在の意図的な逸脱を扱う。維持するか閉じる側に寄せるかは 0618 で決める途中であり、どちらになっても本 issue のチャンク単位の減算は成立する)
