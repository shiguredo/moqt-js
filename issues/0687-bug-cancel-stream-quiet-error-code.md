# cancelStreamQuiet が打ち切りの理由コードを wire に載せていない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-cancel-stream-quiet-error-code
- Polished: 2026-10-25

## 目的

closed の `0646-bug-data-stream-buffer-limit.md` で、上限を超えた受信データストリームを `cancelStreamQuiet` で打ち切る実装を入れた。この経路は文字列 reason しか渡せないため、draft-ietf-moq-transport-22 §12.5 の「reset / STOP_SENDING には relevant なコードを使う SHOULD」を wire 上で満たせず、ピアは打ち切りの理由 (過負荷 / malformed track) をコードで判別できない。

W3C WebTransport の cancel アルゴリズムは、reason が `WebTransportError` で `streamErrorCode` が設定されている場合、その値を application error code として STOP_SENDING に載せる。`cancelStreamQuiet` が `WebTransportError` を渡せるようになれば、§12.5 の SHOULD を満たせる。現行実装は文字列 reason を渡しており、ピアには code 0 (INTERNAL_ERROR) が届く。

同じ問題は 0646 が入れた上限超過だけでなく、malformed track の打ち切りと fill / pending mode の打ち切りにもあり、コードを reason 文字列へ埋め込む経路と埋め込まない経路が混在している。0646 の「残した課題」にも同じ制約が記録されている。

## 現状

- `src/session/stream.ts` の `cancelStreamQuiet` は `reader.cancel(reason)` を呼び、引数は `reason: string` だけである。文字列 reason を渡すと UA は application error code 0 を送る。`ReadableStream` の cancel には専用の code 引数は無いが、reason が `WebTransportError` で `streamErrorCode` が設定されている場合はその値が wire の code になる (W3C WebTransport §9.3 の cancel アルゴリズム)
- この制約と「reason 文字列へコードを埋め込む」回避策は `src/session/dataStreamIncoming.ts` の `dataStreamBufferOverflowReason` の JSDoc に書かれている。同関数は `code=${DataStreamErrorCode.EXCESSIVE_LOAD}` を含む文字列を返す
- コードを埋め込む関数は 2 つある。`dataStreamBufferOverflowReason` は `code=${DataStreamErrorCode.EXCESSIVE_LOAD}` を含む文字列を返し、`dataStreamHandleMalformedFetchTrack` は `code=${DataStreamErrorCode.MALFORMED_TRACK}` を渡す
- コードを埋め込まない経路は次のとおりである
  - `dataStreamHandleMalformedSubgroupTrack` は同じ malformed 打ち切りでありながら `code=` を含めない
  - `dataStreamHandleFillFetchStream` の malformed 打ち切り (catch 内の `cancelStreamQuiet`) は `code=` を含めない
  - `dataStreamHandlePendingSubgroupStream` の abandon 3 か所と `dataStreamHandlePendingSubgroupReadError` は `code=` を含めない
  - `src/session/namespaceLoops.ts` の `namespaceCloseRequestStreamQuiet` は `code=` を含めない
- 受信側はコードを読める。`src/error.ts` の `peerStreamErrorCode` が読み取り失敗値の `streamErrorCode` を取り出し、`normalizeDataStreamErrorCode` で正規化する。`src/session/bidi.ts` の `createResetStreamErrorWithMessage` はこれを使ってアプリへ渡す。Subgroup は `dataStreamNotifySubgroupEnd` が `peerStreamErrorCode` の結果を `errorCode` に載せる
- `src/error.ts` の `DataStreamErrorCode` に `EXCESSIVE_LOAD` (0x9) と `MALFORMED_TRACK` (0x12) は定義済みである
- 送信方向の `WritableStreamDefaultWriter.abort(reason)` は、reason を渡す呼び出しが現状すべて文字列であり、コードを載せていない (`src/session/bidi.ts` の `bidiDispatchResponse` / `handlePublishPeerCancel` / `bidiCancelSubscription` / `bidiCancelFetch`、`src/session/publish.ts` の `publishResetPublisherStream` / `publishCloseSubgroupStream`、`src/session/namespaces.ts` の `namespacesCancelStream` など)。`src/session/lifecycle.ts` の `writer.abort()` は reason を渡さない。本 issue は受信側の `cancelStreamQuiet` のみを対象とし、送信側は pending の `0366-add-delivery-timeout-enforcement.md` が `WebTransportError` を reason に渡す方針を既に持つ
- `src/session.test.ts` の「Subgroup データストリーム: バッファ上限を超えると打ち切られ購読が closed になる」は、cancel の reason に `code=9` が含まれることを現在の契約として固定している。`assertFetchCancelledOnPriorityMismatch` などは reason を文字列として `.includes` しており、`WebTransportError` に変えると更新が必要である
- 0646 の「残した課題」に「`cancelStreamQuiet` の reason は wire のエラーコードを送れないため、§12.5 の『reset / STOP_SENDING には relevant なコードを使う SHOULD』は wire 上では満たせない」と記録されている

## 設計方針

- `cancelStreamQuiet` の引数を `(reader, detail, options?: { errorCode?: DataStreamErrorCode })` に変える。`detail` は診断用の詳細 (対象の識別子・実測値など) であり、reason 文字列そのものではない。`cancelStreamQuiet` の中で `formatStreamAbortReason(detail, options)` を呼び、呼び出し側が書式を組み立てたり `code=` を埋め込んだりする経路を無くす。全呼び出し元は `errorCode` を渡すか渡さないかを明示する
- `formatStreamAbortReason(detail, options)` を 1 関数だけ用意する。`options.errorCode` がある場合は `code=<10 進数>` を含め、無い場合は含めない。これで malformed 打ち切りの書式の非対称 (FETCH は `code=` あり、Subgroup と fill は無し) を解消する
- wire へコードを載せる経路は、`reader.cancel` に `WebTransportError` を渡すことで作る。W3C WebTransport §9.3 の cancel アルゴリズムは、reason が `WebTransportError` で `streamErrorCode` が設定されている場合、その値を application error code として STOP_SENDING に載せる。`WebTransportError` が利用できる環境では `new WebTransportError(formatStreamAbortReason(detail, options), { streamErrorCode: options.errorCode })` を渡す。利用できない環境 (Node のテストなど) では文字列 reason にフォールバックし、wire には code 0 が載る。この分岐は `cancelStreamQuiet` の中の 1 か所だけに置く
- `cancelStreamQuiet` の JSDoc に、`WebTransportError` が利用できる環境では §12.5 の SHOULD を満たし、利用できない環境では code 0 になることを明記する。0646 の「残した課題」は `WebTransportError` が利用できる環境では解消する
- コードを渡すのは、上限超過の `EXCESSIVE_LOAD` (0x9) と malformed track の `MALFORMED_TRACK` (0x12) の 2 種類にする。malformed は FETCH・Subgroup・fill の 3 経路すべてで同じ `MALFORMED_TRACK` を渡す
- コードを渡さない経路を明示する。pending mode の abandon (timeout / overflow / session-close / end-of-stream / subscriber 不在の race) は、複数の理由が同じ経路に混在する。reason ごとにコードを割り当てるのは本 issue の範囲を超えるため、現段階では `errorCode` を渡さない (必要なら別 issue で扱う)。`dataStreamHandlePendingSubgroupReadError` は、ピアの reset が既にコードを持っており、この cancel は後始末であるため `errorCode` を渡さない。`namespaceCloseRequestStreamQuiet` は、レスポンダが既に REQUEST_ERROR でステータスコードを送っており、この cancel は後始末であるため `errorCode` を渡さない。fill の通常失敗は `cancelStreamQuiet` を呼ばないため対象外とする。これらの判断を JSDoc に書く
- アプリへ渡す error の `streamErrorCode` (0646 の実装) は変えない。本 issue は打ち切り理由の wire 送信と reason 書式の統一だけを扱う
- 送信方向の `writer.abort` は本 issue の対象外とし、reason の文字列も変えない。0366 が送信側の abort で `WebTransportError` を渡す方針を既に持つ
- `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」に従い、`CHANGES.md` は更新しない (公開 API のシグネチャと挙動も変えない)
- `src/session.test.ts` に、`WebTransportError` が利用できる場合に `streamErrorCode` が載ること、利用できない場合に文字列 reason の `code=` にコードが含まれること、コードを渡さない経路が `code=` を含まないこと、malformed の 3 経路が同じ書式になることを固定するテストを追加する。`WebTransportError` の注入は `src/session/errors.test.ts` と同じく `globalThis.WebTransportError` を一時的に差し替える方法を使う。既存の reason 文字列を前提にしたテスト (`assertFetchCancelledOnPriorityMismatch` の `.includes`、`cancelReason.startsWith` など) は `String(reason)` または `streamErrorCode` を見る形に更新する

## 完了条件

- `cancelStreamQuiet` が理由コードを引数で受け取れる
- 上限超過の打ち切りが `EXCESSIVE_LOAD` (0x9) を、FETCH・Subgroup・fill の malformed 打ち切りが `MALFORMED_TRACK` (0x12) を、同じ `code=` 書式で reason に含める
- `WebTransportError` が利用できる環境では、渡したコードが `streamErrorCode` として reason に載り、wire の STOP_SENDING に送られる
- `WebTransportError` が利用できない環境では、文字列 reason の `code=` にコードが含まれる
- reason 文字列の組み立てが 1 関数へ集約され、`code=` の書式が全経路で統一される
- コードを渡さない経路 (pending mode の cancel、namespaceLoops の cancel) は `code=` を含まない。fill の通常失敗は cancel を呼ばないため対象外とする
- `cancelStreamQuiet` と `dataStreamBufferOverflowReason` の JSDoc に、`WebTransportError` が利用できる環境では §12.5 の SHOULD を満たし、利用できない環境では code 0 になることが書かれている
- アプリへ渡す error の `streamErrorCode` の挙動が変わらない
- 送信方向の `writer.abort` の reason は変わらない
- 既存の reason 文字列を前提にしたテストが `WebTransportError` 対応に更新される
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-22 §12.5 (Stream Reset Error Codes。冒頭の SHOULD と EXCESSIVE_LOAD 0x9 / MALFORMED_TRACK 0x12)。本文は `refs/moq/draft-ietf-moq-transport-22.txt`
- draft-ietf-moq-transport-22 §12.1 (Malformed Tracks の打ち切り)
- W3C WebTransport (https://www.w3.org/TR/webtransport/)。§9.3 の cancel アルゴリズムは reason が `WebTransportError` で `streamErrorCode` が設定されている場合にその値を application error code として STOP_SENDING に載せる。§7.4 の abort アルゴリズムも同じ。§12.3 が `streamErrorCode` を定義する
- closed `0646-bug-data-stream-buffer-limit.md` (打ち切りを入れた issue。残した課題に `cancelStreamQuiet` の制約がある)
- pending `0366-add-delivery-timeout-enforcement.md` (送信側の `writer.abort` に `WebTransportError` を渡す方針。本 issue の受信側と対になる)
- `src/session/errors.ts` の `WebTransportError` のグローバル検出 (テスト環境で未定義の場合のフォールバック方法)

## 解決方法

{未着手}
