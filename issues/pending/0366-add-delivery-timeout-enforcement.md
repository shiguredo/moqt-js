# Delivery Timeout の強制を実装する

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-delivery-timeout-enforcement
- Polished: 2026-08-07

## 目的

draft-ietf-moq-transport-20 §8 の MUST 要件（OBJECT_DELIVERY_TIMEOUT 超過時のストリームリセット / データグラム破棄、SUBGROUP_DELIVERY_TIMEOUT タイマー）を実装する。現在は値の抽出・伝搬のみで強制が一切ない。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects()` は subgroup 先頭オブジェクトの Object Property から delivery timeout 値を抽出し `MoqtObject.objectDeliveryTimeout` / `subgroupDeliveryTimeout` に保持するだけ。
- `src/session/publish.ts` の `publishSendObjectInternal()` は `mergeDeliveryTimeoutObjectProperties()` で Object Property として送信するだけ。
- タイマー・ストリームリセット・データグラム破棄の実装が存在しない。§8 の「If the OBJECT_DELIVERY_TIMEOUT is not zero ... it MUST reset the underlying transport stream with the reset stream code DELIVERY_TIMEOUT」「For datagrams, the implementation MUST drop the datagrams」「it MUST start a timer of SUBGROUP_DELIVERY_TIMEOUT duration once it becomes aware that all of the objects on the subgroup have been published」のいずれも未実装。
- `DataStreamErrorCode.DELIVERY_TIMEOUT`（0x2）は定義されているが使用箇所がない。

## 設計方針

- Publisher 側（`src/session/publish.ts` と `src/session.ts` の publisher 部分（`publish()` / `sendObject` / `sendDatagram` / `onDoneInternal`））に送信時のタイムアウト強制を実装する:
  - OBJECT_DELIVERY_TIMEOUT: `sendObject()` / `sendDatagram()` の入口（送信キュー `publisherSendQueues` に入れる前）でオブジェクトが提供された時刻を記録し、送信前に経過時間をチェックする（draft-20 §8 本文: "MUST retain the time at which the last header byte of every object has been either received from the upstream subscription, or provided by the original publisher application"。Table 4 も同旨。起算は last header byte であり、moqt-js ではアプリがオブジェクトを提供した時点に相当する。"the implementation MUST check the time elapsed before attempting to pass it to the underlying transport for transmission"）。チェック位置は subgroup ストリームでは **Subgroup Header 書き込み後・オブジェクトの Object Fields 書き込み前の 1 箇所** に統一する（ヘッダーは §11.4.2 の SUBGROUP_HEADER 構造によりストリーム先頭に書く。ヘッダー書き込み前チェックにすると失効先頭オブジェクトでヘッダーが書かれず、committedOffset 0 のリセットになって受信側が subgroup を識別できない。§11.4.3 は committedOffset（reliable_size）にヘッダー長を含める根拠として引用する）。超過時:
    - subgroup ストリーム: `streamErrorCode` に `DELIVERY_TIMEOUT` を設定した `WebTransportError` を reason に渡して `writer.abort()` を呼び、ストリームをリセットする（W3C WebTransport CR (2026-07-30) §7.4 の abort アルゴリズムは committedOffset 付きの RESET_STREAM_AT に該当する）。リセットした subgroup は `closedSubgroups` に追加し、後続の送信を `ClosedSubgroupError` で拒否する（§8 の SHOULD NOT: "SHOULD NOT attempt to open a new stream to deliver additional Objects in that Subgroup"）。失効した先頭オブジェクトは、オブジェクトデータを書かずにヘッダーのみ書き込んだ状態でリセットする（§11.4.3 の「header のみを reliable に残す」意図に整合。§11.4.3 の引用文言は「a new stream に SUBGROUP_HEADER を送り RESET_STREAM_AT する」という別ストリームの MAY であり、本 issue の「現行ストリームを abort する」設計とは適用対象が異なる点に注意）。非先頭オブジェクトの失効時は、ヘッダーと先行オブジェクトが書き込み済みの状態でそのまま abort する（committedOffset にはヘッダー + 先行オブジェクトが含まれる。失効オブジェクトの Object Fields は書かれない）。**失効フローの全体像**: 失効したオブジェクトはストリーム全体を DELIVERY_TIMEOUT でリセットした上で、そのオブジェクト自体の `sendObject()` の Promise のみ reject せず resolve する（abort は例外を投げない自発的リセットであり、失効はアプリの入力ミスではない。`publisher.handleError` も呼ばない）。ストリームは継続せず、後続の `sendObject()` は closedSubgroups により `ClosedSubgroupError` で拒否され `publisher.handleError` に流れる。`sendObject()` の doc コメント（「object が WebTransport stream に書き込まれて完了した時点で resolve」）に、失効時は書き込みなしで resolve し、失効後の後続送信は `ClosedSubgroupError` になる旨を追記する。abort() の戻り Promise は catch で吸収する（abort 失敗は自発的リセットの一部であり publisher エラーにしない）。
    - datagram: 送信せず破棄する（詳細は後述）。
  - SUBGROUP_DELIVERY_TIMEOUT: subgroup の FIN 送信時（group 遷移時の `writer.close()` と `closePublisherStream` の両方）からタイマーを開始する。**END_OF_GROUP ステータスのオブジェクト送信はタイマー開始点としない**（moqt-js の 1 Group = 1 Subgroup = 1 Stream モデルでは END_OF_GROUP 送信でストリームを閉じないため、次の group 遷移までタイマーが未開始になる期間が生じる。§8 の「all of the objects on the subgroup have been published」の検知は moqt-js の API 形状（group 遷移 / done() のみ）に写像される）。満了時に配信未完了なら `writer.abort()` でストリームをリセットする（§8: "If the timer expires before the underlying transport stream reaches 'all data committed' state ... the implementation MUST reset the stream"）。満了時の abort reason は OBJECT_DELIVERY_TIMEOUT 超過時と同様に `streamErrorCode` を `DELIVERY_TIMEOUT`（0x2。§3.3.4「A delivery timeout (Section 8) was exceeded for this stream」）とした `WebTransportError` とする。リセットした subgroup は OBJECT_DELIVERY_TIMEOUT 超過時と同様に扱い、close() が完了した時点でタイマーを破棄する。
  - **W3C WebTransport の close / abort のセマンティクス（CR 2026-07-30 §7.4）**: close() はストリームが "all data committed" 状態に達するまで resolve しない。abort() は committedOffset 付きの RESET_STREAM_AT を送るが、**pending の close() promise を abort reason で reject する**（「settle させない」ではない）。したがって、abort() 後に close() の promise が reject された場合は catch で吸収する（セッションクローズや publisher エラーにしない）。また、Streams 標準の `WritableStreamAbort` は closing 状態のストリームで abortAlgorithm（RESET_STREAM_AT 送信）が呼ばれない可能性があり、**タイマー発火時に close() が既に完了（または closing 進行中）のストリームで abort() が RESET_STREAM_AT を送信できるかはブラウザ実装依存**である。この不確実性を実ブラウザで検証し、abort が機能しない場合は「close() 完了を待つ」フォールバックを採る（検証手段は完了条件を参照）。
  - **committedOffset の反映（commit()）**: abort() の直前に、書き込み済みバイト（Subgroup Header を含む）を committedOffset（RESET_STREAM_AT の reliable_size）に反映する（§11.4.3: "When RESET_STREAM_AT is used, the reliable_size SHOULD include the stream header so the receiver can identify the corresponding subscription"）。**commit() は abort() の直前に毎回呼ぶ**（commit() は「呼び出し時点の [[BytesWritten]]」を [[CommittedOffset]] に反映するだけのため、ヘッダー書き込み後に 1 回だけ呼ぶと、途中失効・タイマー満了時の abort で先行オブジェクトのデータが全て失われる。「ヘッダー write() の resolve を待ってから commit() を呼ぶ」は先頭オブジェクト失効ケースの順序要件であり、途中失効・タイマー満了時は直前の全 write() の resolve 後に commit() してから abort() する。[[BytesWritten]] は write() の resolve 時点で加算される）。commit() は W3C WebTransport CR (2026-07-30) §11.1 で新設された `WebTransportWriter` のメソッドであり、現行の TypeScript 型定義（`WritableStreamDefaultWriter`）には存在しない。実装時は (a) ブラウザ実装・型定義で `WebTransportWriter`（または `stream.commit()`）が利用可能か確認して採用する、または (b) 利用不可の場合は commit 相当の手段（RESET_STREAM_AT の reliable_size をヘッダー長分に設定する方法の有無）を調査して確定する。**(b) の調査結果が「不可能」だった場合は、チェック位置・リセット方式（committedOffset 0 のリセットで受信側が subgroup を識別できない問題）を見直す**。どちらも `streamState` に stream 参照を保持する変更が必要になる（現行は `{ groupId, writer, previousObjectId }` のみで stream を保持しない。あわせて subgroup で確立したタイムアウト値も保持する）。
  - group 遷移時の `writer.close()` 待ちにはタイムアウトガードを設ける（既存の `publishClosePublisherStreamInternal`（`src/session/publish.ts`）の 5 秒ガードと同じ方式）。SUBGROUP_DELIVERY_TIMEOUT タイマーが先に発火して abort() した場合、close() の promise は abort reason で reject されるため、その settle（reject）を吸収したうえで後続の送信を続行する（5 秒ガードとタイマーの優先順位は実装時に確定する。タイマー発火で close 待ちを中断する方式（`Promise.race([close(), 5 秒ガード, タイマー発火の reject])` 等）を採用し、タイマー発火後も 5 秒ストールしないこと）。**race に渡す close() の promise には、race の戻りとは別に個別の `.catch(() => {})` を付けておく**（race に負けた promise の後発 settle（reject）は race の戻りでは観測されず、catch を付けないと unhandled rejection になる）。タイマーの保持: group 遷移時は publisherStreams から削除された後のストリームをクロージャで保持し、close() が 5 秒ガードで中断された場合（close が pending のまま）もタイマーは発火まで維持する。セッションクローズ時（`closeWriterSafely` 経路）にも全 publisher のタイマーを破棄する。
  - datagram: datagram には OBJECT_DELIVERY_TIMEOUT と SUBGROUP_DELIVERY_TIMEOUT の両方が作用し、両方非ゼロなら小さい方を適用する（§8: "For objects whose Object Forwarding Preference is Datagram, the SUBGROUP_DELIVERY_TIMEOUT acts the same way as OBJECT_DELIVERY_TIMEOUT; if both are non-zero, the smaller of the two is used"）。datagram の提供時刻は `publishSendDatagram()` の入口で記録する（draft-20 §8 の provided by the original publisher application に相当し、last header byte 起算と一致する）。`publishSendDatagram()` は同期実行のため、提供時刻から `writer.write()` までの経過時間は実質 0ms であり、送信前チェックは通常発動しない。datagram のキュー滞留による遅延は §8 の SHOULD（"implementations SHOULD either minimize datagram queueing, or use datagram queueing mechanisms that support time bounds (such as the outgoingMaxAge parameter in the W3C WebTransport API)"）に従う。ただし `outgoingMaxAge` は `WebTransportDatagramDuplexStream`（セッションに 1 つ）の属性であり、トラックごとに異なるタイムアウト値を表現できない。対応方針: (a) アクティブな publisher の datagram タイムアウトの最小値を `datagrams.outgoingMaxAge` に設定する（値 0 / 未設定は無限大として扱う。moqt-js に設定 API がないため、`ConnectOptions` 等への追加を検討する）、または (b) 本 issue では outgoingMaxAge を設定せず、送信前チェック（同期実行のため実質発動しない）+ datagram 破棄ロジックのみを実装し、outgoingMaxAge は別 issue で扱う。**(b) を採用する**（SHOULD であり未対応でも仕様違反にならない。outgoingMaxAge の設定 API 追加は別 issue の対応とする）。
  - タイムアウト値は publisher の値を用いる。`publish()` の options（Track Property）の値を PublisherImpl に保持し、subgroup 先頭オブジェクトの `SendObjectParams`（Object Property）で上書きされた値があればそれを使う（§8: "the publisher's value is the Object Property when present on the first object of the subgroup, and the Track Property otherwise"）。強制値の決定は「型付きフィールド（`deliveryTimeout` / `subgroupDeliveryTimeout`）を優先し、なければ `readDeliveryTimeoutObjectProperties()` で `properties` バイト列から抽出する（受信側と同じ寛容デコード。`SendObjectParams.properties` に手書きで Object Property を載せたケースを含む）」とする。subgroup で確立した値は `streamState` に保持し、その subgroup 内の全オブジェクトの判定に適用する（§12.2: "it overrides the Track-level value for that subgroup"）。datagram には Track Property 値を適用する。提供時刻は `publishSendObject` / `publishSendDatagram` の入口で記録し（draft-20 §8 の provided by the original publisher application に相当し、last header byte 起算と一致する）、送信キューに積むクロージャで保持する（公開型 `SendObjectParams` に内部用フィールドを追加しない）。
  - 値 0 はタイムアウトなし（強制しない）。
- Subscriber 側は受信値の保持（現状のまま）とし、受信側でのタイムアウト適用は行わない。§8 の強制はすべて転送側の義務として規定されており、受信専用の Subscriber には強制義務がない。
- subscriber 値との比較（§8: "If both the publisher's value and the subscriber's value are non-zero, the smaller of the two is used"）は、両方の値を知るエンドポイント（典型的にはリレー）の責務であり対象外とする。moqt-js は SUBSCRIBE を受信する経路を持たないクライアントライブラリのため（`src/session.ts` の `handleIncomingBidirectionalStream()` は受信双方向ストリームの先頭メッセージを PUBLISH のみ許可）。なお draft-20 では Subscription Parameters は PUBLISH_OK ではなく REQUEST_UPDATE に載る（Appendix A.1 #1790）ため、両パラメータは PUBLISH_OK には出現しない（`PUBLISH_OK_ALLOWED_PARAMS` は EXPIRES のみ）。moqt-js は PUBLISH_OK 受信時に delivery timeout の比較・適用を行わない（リレーの責務として対象外）。
- 過去判断との関係: closed issue 0342 は「タイマー実行・ストリーム reset / datagram drop は範囲外」とし、closed issue 0178 も自前タイマー方式を対象外とした。本 issue はこれらの対象外を意図的に覆す follow-up である。
- `PublishOptions.deliveryTimeout` / `SubscribeOptions.deliveryTimeout` の doc コメント（「Publisher と Subscriber の両方が指定した場合、小さい方の値が使用される。」）の修正は別 issue 0395 で対応する。

## 完了条件

- OBJECT_DELIVERY_TIMEOUT 超過時に subgroup ストリームが `DELIVERY_TIMEOUT` コードでリセットされ、リセットした subgroup への後続送信が拒否される（チェックは Subgroup Header 書き込み後・オブジェクトデータ書き込み前）。
- OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT（両方非ゼロなら小さい方）超過時にデータグラムが破棄される。送信前の経過時間チェックと超過判定は純粋関数として実装され、単体テストで検証されていること（t0 は `publishSendObject` / `publishSendDatagram` 入口の提供時刻とし、draft-20 §8 の provided by the original publisher application に従う）。
- SUBGROUP_DELIVERY_TIMEOUT タイマーが発火し、配信未完了の subgroup ストリームがリセットされ、リセットした subgroup への後続送信が拒否される。
- abort() 後の close() promise の reject が catch で吸収され、unhandled rejection・セッションクローズにならないこと。
- closing 状態のストリームに対する abort() の挙動（RESET_STREAM_AT が送信されるか）の検証: 単体テストで検証可能な部分（経過時間チェック・超過判定・closedSubgroups 登録・abort 呼び出し判定）は単体テストで決定的に検証し、closing 状態の abort の実ブラウザ挙動は e2e（`tests/e2e/`。既存 spec への追記または新規 spec。`TEST_MOQT_URI` 依存で常時実行されないため、手動実行による確認を含む）で検証する。abort が機能しない場合は「close() 完了を待つ」フォールバックが実装されていること。あわせて「ヘッダーのみ書き込み + リセット」のストリームを moqt-js の受信側（`handleSubgroupStream`）が正しく処理する結合検証（同一ライブラリの publisher / subscriber を同一 relay に接続）を含める。
- commit() 相当の committedOffset 反映方法（`WebTransportWriter` の利用可否に応じて確定。各 abort の直前に commit() を呼ぶ順序を含む）と、stream 参照・subgroup 確立タイムアウト値の `streamState` 保持が実装されていること。(b) の調査結果が「不可能」だった場合は、チェック位置・リセット方式の見直しが実装されていること。
- 失効したオブジェクトの `sendObject()` が reject せず送信スキップで resolve し、`publisher.handleError` も呼ばれず、後続の `sendObject()` は `ClosedSubgroupError` で拒否されること（テストがあること）。
- 各タイムアウトの動作を検証するテストがあること（経過時間チェック・超過判定は時刻ソースを注入可能な純粋関数とし、タイマー発火テストは実時間の短い timeout で行う。モック / スタブは使わない）。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-20 §3.3.4 (Stream Reset Error Codes)
- draft-ietf-moq-transport-20 §8 (Delivery Timeouts and Data Reliability)
- draft-ietf-moq-transport-20 §10.2.3 / §10.2.4 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-20 §11.4.3 (Closing Subgroup Streams)
- draft-ietf-moq-transport-20 §12.1 / §12.2 (SUBGROUP_DELIVERY_TIMEOUT / OBJECT_DELIVERY_TIMEOUT Property)
- W3C WebTransport CR (2026-07-30) §5.3 (WebTransportDatagramDuplexStream) / §7.4 (WebTransportSendStream の close / abort アルゴリズム) / §11.1 (WebTransportWriter / commit())
- WHATWG Streams Standard (WritableStreamDefaultWriter の abort / close / releaseLock / write)
- 関連: `issues/closed/0342-draft-19-delivery-timeout-object-property.md`（タイマー・リセットを範囲外とした。本 issue はその follow-up）
- 関連: `0363-bug-varint-overflow-wrap.md`（`publishSendObjectInternal` の新規 Subgroup 経路の後始末を変更対象とする。同一経路のため実装順序を調整する: 0363 の方式確定（ヘッダーエンコード位置）が 0366 のチェック位置と干渉するため、0363 を先に実装し、0366 はその後に `closedSubgroups` 登録の扱いを合わせる）
- 関連: `0390-moqt-draft-19-unexport-internal-symbols.md`（`publishSendObjectInternal` / `publishClosePublisherStreamInternal` を非公開化対象とする。本 issue のテストが export を要求する場合は調整注記を追加する）
- 関連: `0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（`done()` 経路の `closePublisherStream` に SUBGROUP_DELIVERY_TIMEOUT による abort を追加しても PUBLISH_DONE 送信順序（0370 の前提）は変わらない）
- 関連: `0395-fix-delivery-timeout-options-doc-comment.md`（`PublishOptions` / `SubscribeOptions` の deliveryTimeout doc コメント修正を分離）

## pending にする理由

本 issue の完了条件と設計方針には、自動対応（`/auto-resolve`）では扱えない実験的検証と設計分岐が含まれるため pending に退避する。手動で段階的に導入する。

- 完了条件「closing 状態のストリームに対する abort() の挙動（RESET_STREAM_AT が送信されるか）の検証」は実ブラウザでの手動 e2e 検証（`TEST_MOQT_URI` 依存で常時実行されない）を明示的に要求している。abort が機能しない場合の「close() 完了を待つ」フォールバック採否は静的コードのみで確定できず、実装後にブラウザ挙動を測って決める分岐が残る。
- 「commit() 相当の committedOffset 反映方法」の (a) `WebTransportWriter.commit()` 直接利用 / (b) 代替手段調査（不可能なら「チェック位置・リセット方式を見直す」）の分岐は、ブラウザ実装と型定義パッケージのバージョン確認、および (b) 不可のときの設計変更（Subgroup Header 書き込み後・オブジェクトデータ書き込み前という基本方針そのものの再検討）を伴う。
- 変更対象範囲が広く（`src/session/publish.ts` / `src/session.ts` / `src/session/stream.ts`、タイマー実装・純粋関数モジュールの新設、e2e への追記）、単一 PR での自動レビュー・自動マージには適さない。

以上の判断が確定するまで pending 退避とする。実装を再開するときは、(1) ブラウザで `WebTransportWriter.commit()` の可用性を確認し (a)/(b) の分岐を確定させる、(2) e2e で closing 状態の abort 挙動を測定してフォールバック採否を確定させる、(3) 上記結果を踏まえて本 issue の設計方針を確定させ直したうえで再オープンする、の順で進める。

## 解決方法

未着手。
