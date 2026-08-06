# PUBLISH_OK 後にピアが FIN すると PUBLISH_DONE が送信されない

- Priority: High
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-publish-done-skipped-after-peer-fin
- Polished: 2026-08-06

## 目的

draft-ietf-moq-transport-19 §3.3.2 の MUST 要件「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」を満たす。現在はピアが PUBLISH_OK 後に送信方向を FIN すると、後から呼ばれた `publisher.done()` が PUBLISH_DONE 送信と FIN の両方を静かにスキップし、§10.11 の終了通知がピアに届かない。

## 優先度根拠

draft-ietf-moq-transport-19 §5.1 により publisher が PUBLISH を送信し subscriber が PUBLISH_OK で受諾して subscription が Established に遷移する。§5.1 の状態遷移と §10.5 (PUBLISH_OK は PUBLISH への REQUEST_OK 応答) により、moqt-js は publisher (= requester)、ピアは subscriber (= responder) である。§3.3.2 は「A FIN sent by the responder after its response and any subsequent messages for the request signals that the request is complete; if it has not already done so, the requester SHOULD then send a FIN on its direction, gracefully closing the stream.」と定めており、ピアが PUBLISH_OK 後に送信方向を FIN するのは合法な動作である。このとき moqt-js は §3.3.2 の MUST を優先し、PUBLISH_DONE を送信してから自方向を FIN で閉じる必要がある (FIN 送信自体は SHOULD)。現状はそれができないため、仕様準拠のピアが送信方向を FIN した場合に発現するライフサイクルバグである。High。

## 現状

- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の finally)、`src/session/publish.ts` (`publishSendPublishDone` の close 失敗処理)、`src/session/errors.ts` (キャンセル判定の新規ヘルパーを純関数として追加)、`src/session/errors.test.ts` (ヘルパーの単体テスト)、`src/session.ts` (誤コメント修正のみ)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。
- `src/session/bidi.ts:667` の `if (done) break;` でピアの FIN を検出すると読み取りループを抜け、finally ブロック (`src/session/bidi.ts:831-849`) の `session.requestStreams.delete(requestId)` (848 行) が実行される。finally は publish / subscribe 両ロール共通のコードであり、publish ロールに対する特別扱いはない。
- その後 `publisher.done()` → `onDoneInternal` (`src/session.ts:1483-1488`: `closePublisherStream` → `sendPublishDone`) → `publishSendPublishDone` (`src/session/publish.ts:322-373`) は `session.requestStreams.get(requestId)` (342 行) が `undefined` のため、`if (streamInfo)` (343 行) で PUBLISH_DONE の送信と `writer.close()` の両方を静かにスキップする。
- `closePublisherStream` (`publishClosePublisherStreamInternal`、`src/session/publish.ts:226-251`) はデータ送信ストリーム (subgroup stream) のみを閉じ、bidi リクエストストリームの writer は閉じない。
- `publishSendPublishDone` の write 失敗 (351-355 行) は既に黙殺されており、close 失敗時 (`src/session/publish.ts:359-368`) は `session.closeWithError(PROTOCOL_VIOLATION)` でセッション全体を閉じる。

## 設計方針

- **修正方針の決定**: 案 A「`requestStreams` からの削除タイミングを publisher の `done()` 完了後まで遅らせる」を採用する。案 B「writer を別途保持する」は保持先フィールドの追加と二重管理が必要になり変更範囲が大きいため不採用。採用案の実装は finally の削除処理を **publish ロールかつ graceful FIN の場合のみ** 遅延する形にする (subscribe ロールの finally 挙動は変更しない)。
- **finally の保持条件 (exit-path 判別)**: `bidiReadRequestStreamMessages` の finally は複数の経路で実行される。(a) 667 行の `if (done) break;` が唯一の保持対象であり、その直前にローカルフラグ (例: `receivedFin = true`) を立て、finally の `delete` を「publish ロール && フラグ」の場合のみスキップする。それ以外の経路 (GOAWAY の `return`、未知メッセージの `closeWithError + return`、REQUEST_UPDATE の subscribe ロール早期 `return`、パラメータスコープ検証失敗の `return`、catch (RESET_STREAM 等)、`while` 条件 (セッション終了) による自然終了) はすべて従来どおり削除する。
- **FIN とキャンセルの区別**: ピアが FIN (graceful、`reader.read()` が `{done: true}`) した場合は PUBLISH_DONE 送信を継続する。ピアが RESET_STREAM で自方向をリセットした場合は `reader.read()` が reject して catch に落ちる経路であり、writer 保持の対象にしない。なお STOP_SENDING はピアが当方の送信方向に対して送る信号であり `reader.read()` は reject しない。§3.3.3 の「An endpoint that has already sent a FIN on its sending direction and subsequently wishes to cancel sends STOP_SENDING on the receiving direction」により、本 issue の修正対象シナリオ (ピアが FIN 済み) でのキャンセルは STOP_SENDING 単独で到来し、`done()` の `writer.close()` 失敗として顕在化する。
  - **キャンセル判定**: ピア起因のキャンセル (§3.3.3 で合法) をセッション終了に昇格させない。判定は失敗オブジェクトの `source` プロパティを直接読み、`"stream"` である場合をピア起因のストリームエラーとみなし非昇格 (黙殺) とし、それ以外の失敗は従来どおり PROTOCOL_VIOLATION で検出する。`source` は `WebTransportError` の `instanceof` 成否に関わらず直接読む (テスト環境の Node には `WebTransportError` グローバルが存在しないため、`typeof` ガードをせずプレーンオブジェクトのプロパティとしてアクセスする)。失敗値が `null` / `undefined` 等の非オブジェクトの場合は `source` 非該当として昇格側に落とす。エラーコード (`streamErrorCode`) による判定は採用しない。理由: §3.3.4 のエラーコードは SHOULD 推奨であり、ピアが STOP_SENDING / RESET_STREAM にどのコード (CANCELLED 0x1 / DELIVERY_TIMEOUT 0x2 / 未登録値等) を載せるかは任意のため、コード集合で判定すると合法的なキャンセルを再昇格し得る。なお `source === "stream"` 一律黙殺は、ピア起因のキャンセル以外の stream エラーも PROTOCOL_VIOLATION 検出から漏れるトレードオフを伴うが、これを意図的設計として許容する。新規ヘルパー (例: `isPeerStreamError(error: unknown): boolean`) を `src/session/errors.ts` に純関数として追加する。既存の `isSessionClosedError` はメッセージ文字列フォールバック方式であり本判定とはフォールバック内容が異なるため、流用せず別関数とする。
  - **write パスは変更しない**: `publishSendPublishDone` の write 失敗 (351-355 行) は現状どおり黙殺を継続する。非昇格判定は close 失敗 (359-368 行) にのみ適用する。
- **PUBLISH_OK 受信前のピア FIN**: publish ロールのループ (`bidiReadRequestStreamMessages`) は `bidiReadPublishResponse` (`src/session/bidi.ts:278`) が PUBLISH_OK を受信した後にのみ起動される (`bidi.ts:328`)。受信前の FIN は `bidiReadResponseFromBidiStream` の throw → `bidiReadPublishResponse` の catch で `pendingPublish` reject + `requestStreams` 削除という既存経路に落ちる (§3.3.2 の「treats the request as failed」に整合)。したがってループ内に「受信前」ケースは存在せず、finally 側では区別のための追加分岐は不要である。受信前 FIN の失敗処理は既存経路のまま変更しない。
- **done() 未呼び出し時のクリーンアップ**: 修正後、ピア FIN 後にアプリが `done()` を呼ばない場合、`requestStreams` / `publishers` のエントリはセッション close 時のクリーンアップ (`src/session.ts:2406-2409` の `abortWriterSafely` + `clear`) まで残る。これを許容する (現状も `publishers` は done() まで残るため、追加される残留は `requestStreams` のみで、セッション終了時には回収される)。
- **§10.11 の前提条件**: §10.11 の「A sender MUST NOT send PUBLISH_DONE until it has closed all streams it will ever open, and has no further datagrams to send, for a subscription」に従い、`done()` がデータストリームの閉鎖 (`closePublisherStream`) を先に完了してから PUBLISH_DONE を送る現行の順序 (`onDoneInternal`) を維持する。また §10.11 の「A sender MUST NOT destroy subscription state until it sends PUBLISH_DONE」に照らすと、done() が PUBLISH_DONE を送れないまま `session.publishers.delete(requestId)` を実行する現状 (`publish.ts:372`) はこの MUST に抵触する。削除タイミングの遅延はこの MUST への適合にもなる。なおこの分析は正常終了 (PUBLISH_DONE 送信) 経路に限定される。STOP_SENDING キャンセル時は §5.1 により subscription が Terminated に遷移しており §10.11 の MUST は適用されず、その後の状態破棄は正当である。
- **誤コメントの修正**: `src/session.ts:1484` の「// まずストリームを閉じる（FIN を送信）」は `closePublisherStream` の実体 (データストリームの閉鎖) と食い違っており、closed issue 0339 の解決方法で約束されながら未修正のまま残っている。本 issue の修正経路 (`onDoneInternal` → `publishSendPublishDone`) に含まれるため、挙動変更なしで実体に合わせて修正する (目標文言は完了条件参照)。
- **スコープ外の明示**: subscribe ロール側の finally 挙動 (ピアが PUBLISH_DONE なしで FIN した場合の subscriber 通知) は issue 0374 で扱う。0374 も本 issue と同じ finally ブロックと FIN 検出点を変更対象とするため、実装順序は本 issue (0370) を先に実施し、0374 は 0370 完了後に finally のロール分岐が入った状態で実装する (0370 の「publish ロール && フラグ」分岐は subscribe ロールの挙動を変えないため、0374 の subscribe 側変更と干渉しない)。GOAWAY ハンドラの return 経路の `requestStreams` 削除は issue 0372 で扱うが、0372 の完了条件は「重複 GOAWAY の検出」「旧リクエストストリームのクローズ」であり、GOAWAY 後にアプリが `done()` を呼んだ場合の PUBLISH_DONE スキップは含まれない (0372 の実装が GOAWAY 後に読み取りを継続する場合は本 issue のフラグ経路に合流し得るが、0372 の実装次第である)。本 issue の finally 変更は GOAWAY 経路には適用しないため、GOAWAY 後の PUBLISH_DONE スキップは 0372 修正後も残余として残り得る。サーバー側の受信 PUBLISH 処理 (`runPublishStreamSubLoop`、`src/session.ts:3169`) は PUBLISH_DONE の送信者がピア側であり本 issue の対象外。
- **issue 0390 との調整**: 0390 (未使用 export の非公開化) の対象に `bidiReadRequestStreamMessages` (`bidi.ts:656`) と `bidiReadResponseFromBidiStream` (`bidi.ts:253`) が含まれる。本 issue のテストの駆動関数は `bidiReadPublishResponse` (`bidi.ts:278`) とする。同関数は 0390 の非公開化対象外であり、内部で `bidiReadResponseFromBidiStream` を呼ぶため「受信前 FIN → 失敗」の経路を検証できる。したがって 0370 側が export を要求する関数は `bidiReadRequestStreamMessages` のみであり、0390 側には「テストで使用する `bidiReadRequestStreamMessages` の export を維持する」旨を明記する調整が必要である。0390 を先に実施するとテストが破綻するため、本 issue (0370) を先に実施する。なお `publishClosePublisherStreamInternal` (`publish.ts:226`) も 0390 の対象だが、テストは公開済みのラッパー `publishClosePublisherStream` (`publish.ts:211`) 経由で構成できるため、0370 側で export を要求しない。

## 完了条件

- PUBLISH_OK 受信済みの publish ストリームでピアが送信方向を FIN しても、`publisher.done()` が PUBLISH_DONE を送信し、その後自方向を FIN (`writer.close()`) で閉じること。
- ピアが RESET_STREAM / STOP_SENDING でキャンセルした場合はセッションを閉じないこと。`publishSendPublishDone` の close 失敗のうち `source === "stream"` の失敗 (ピア起因のキャンセル) は PROTOCOL_VIOLATION に昇格せず黙殺され、それ以外の失敗は従来どおり PROTOCOL_VIOLATION で検出されること。write 失敗 (351-355 行) は現状どおり黙殺を継続し、本 issue では変更しないこと。
- PUBLISH_OK 受信前のピア FIN は既存の `bidiReadPublishResponse` 経路でリクエスト失敗として処理されること (検証は `bidiReadPublishResponse` を駆動し、pendingPublish の reject と `requestStreams` からの削除まで確認する)。
- 上記シナリオを検証するテストがあること。テストは本 issue で新設する方式に従う: W3C WebTransport 双方向ストリーム相当 (`ReadableStream` + `WritableStream`、Node 22 のグローバル) を `as unknown as WebTransportBidirectionalStream` で注入し、`controller.close()` で FIN (`{done: true}`) を再現する。ピアの FIN 後に `publisher.done()` を呼び、WritableStream の sink で PUBLISH_DONE バイト列の書き込みと `close()` の順序を検証する (PUBLISH_DONE → FIN の送信順序検証はリポジトリ初であり、closed issue 0339 の完了条件にあった未実装のテストを引き継ぐ)。RESET は readable の `controller.error(reason)` で `reader.read()` を reject させて再現し、RESET 後に `done()` を呼んでも PUBLISH_DONE を送らずセッションも閉じないことを検証する。STOP_SENDING による close 失敗は、sink の `close()` に `WebTransportError` 相当 (`{ source: "stream", streamErrorCode: 0x1 }`) を throw させて再現する (ストリーム機構は実物であり、モック / スタブではない。失敗注入点は sink のみ)。`source === "stream"` の非昇格がエラーコード非依存であることを検証するため、CANCELLED (0x1) 以外のコード (例: DELIVERY_TIMEOUT 0x2) でも非昇格になるケースを含める。昇格ブランチの検証として、sink の `close()` に `source` を持たない Error を throw させ、`closeWithError(PROTOCOL_VIOLATION)` が呼ばれることを検証する。新規ヘルパー (`isPeerStreamError`) の単体テストを `src/session/errors.test.ts` に追加する (既存の FakeWebTransportError 前例に沿う)。session 相当のオブジェクトは実 Map、実 `ControlStreamReader`、実 `ControlStreamWriter`、実ストリームで構成し、`transport` (`WebTransport` 型) 等のテストで未使用のフィールドのみ型キャストで満たす。既存の `src/session/bidi.test.ts` は `as unknown as BidiSessionInternal` の部分モックで純関数を検証する方式であり、ストリーム注入の前例はないため、本テストはストリーム注入部分でリポジトリ初のパターンとなる。e2e (`tests/e2e/`) は `TEST_MOQT_URI` 依存で常時実行されないため対象外とし、単体テストで決定的に検証する。subscribe ロールでは finally が従来どおり `requestStreams` を削除すること (ロール分岐の回帰がないこと) も確認する。
- 誤コメント修正: `src/session.ts` の `onDoneInternal` のコメントが「データストリーム閉鎖 → PUBLISH_DONE → リクエストストリーム FIN」の内容に修正されていること (挙動変更なし)。
- 後方互換: 公開 API (`Publisher.done()` 等) のシグネチャは変更しない。動作変化は「ピア FIN 後も PUBLISH_DONE + FIN が送信されるようになる」「ピア起因のキャンセルでセッションが閉じなくなる」の 2 点 (キャンセル時の close 失敗は現状の FIN 済みシナリオでは到達不能、STOP_SENDING 単独シナリオでは PROTOCOL_VIOLATION で閉じていた)。セッション close 中の `done()` は `markClosed()` により no-op になる既存挙動が維持されること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection)
- draft-ietf-moq-transport-19 §3.3.4 (Stream Reset Error Codes)
- draft-ietf-moq-transport-19 §5.1 (Subscriptions / Established 状態遷移)
- draft-ietf-moq-transport-19 §10.5 (REQUEST_OK / PUBLISH_OK)
- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE)

## 解決方法

未着手。
