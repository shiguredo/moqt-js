# 未対応リクエストの受信でセッションを PROTOCOL_VIOLATION で終了してしまう

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-10
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-incoming-request-not-supported-response
- Polished: 2026-08-07

## 目的

draft-ietf-moq-transport-19 §3.3 は双方向ストリームの先頭メッセージとして 7 種 (TRACK_STATUS / SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE / SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS) を許可し、PROTOCOL_VIOLATION は「7 種以外のメッセージタイプで始まる場合」の MUST に限定している。現在の実装は PUBLISH 以外の 6 種 (moqt-js が未対応のリクエスト) を誤って PROTOCOL_VIOLATION でセッション終了しており、§4 (Extensibility) の SHOULD「Limited endpoints SHOULD respond to any unsupported messages with the appropriate NOT_SUPPORTED error code, rather than ignoring them.」に反する。未対応のリクエストには REQUEST_ERROR (NOT_SUPPORTED) を応答してセッションを維持する。

## 優先度根拠

`publishNamespace()` で namespace を広告すると、§9.5 (Publisher Interactions) により仕様準拠のリレーは SUBSCRIBE を送信し得る（リレーが publisher に FETCH を送り得る根拠は §10.12 の Joining Fetch）。このとき moqt-js はセッション全体を PROTOCOL_VIOLATION で閉じてしまうため、Namespace 公開機能を使うと仕様準拠リレーとのセッションが即終了する。本対応で達成されるのは「セッション維持」であり「Namespace 公開機能の完全な併用」ではない。Medium。

## 現状

- `src/session.ts` の `handleIncomingBidirectionalStream` で、先頭メッセージが PUBLISH 以外の場合に `closeWithError(PROTOCOL_VIOLATION)` でセッション全体を閉じる (エラー文言は「expected PUBLISH as first message...」)。この分岐と `sendRequestErrorAndCancel` は closed issue 0317 (SUBSCRIBE_TRACKS 経由の受信 PUBLISH 実装) が新設したものである。
- 変更対象ファイル: `src/session.ts` (`handleIncomingBidirectionalStream` の分岐差し替え、`sendRequestErrorAndCancel` の削除)、`src/session/incoming.ts` (ディスパッチと拒否フローの free function 化、モジュール doc 追記)、`src/session/incoming.test.ts` (テスト新設)、`CHANGES.md`。
- 必要な部品は既存: `RequestErrorCode.NOT_SUPPORTED` (`src/error.ts`)、`sendRequestErrorAndCancel` (`src/session.ts`)。

## 設計方針

- **受信先頭メッセージの 3 分類**: `handleIncomingBidirectionalStream` の先頭メッセージ判定を以下の 3 分類に変更する。
  1. PUBLISH (対応済み): 従来どおり処理を継続する。
  2. 7 種のうち未対応の 6 種: REQUEST_ERROR (NOT_SUPPORTED) を応答してストリームを閉じる (§4 SHOULD)。
  3. 7 種以外 (未知タイプ等): §3.3 の MUST「Bidirectional streams MUST NOT begin with any other message type unless negotiated. If they do, the peer MUST close the Session with a PROTOCOL_VIOLATION.」により従来どおり PROTOCOL_VIOLATION でセッションを閉じる。moqt-js は先頭メッセージタイプのネゴシエーション機構を持たないため、分類 3 の適用に「unless negotiated」の考慮は不要である。分類 2 との区別を明示しないと、未知タイプに NOT_SUPPORTED を返す §3.3 違反の実装になり得る。
- **ディスパッチと拒否フローの free function 化**: `handleIncomingBidirectionalStream` の 3 分類ディスパッチ部分を `src/session/incoming.ts` (受信系 free function 群) に抽出する。抽出する関数:
  - `incomingClassifyFirstBidiMessage(type: number): "publish" | "unsupported-request" | "protocol-violation"` — 3 分類の純粋関数。`src/controlStream.ts` の `ControlMessage.type` は `number` であるため、未知タイプも表現できる number 入力で定義する。
  - `incomingSendRequestErrorAndClose(stream, errorCode, reasonPhrase): Promise<void>` — REQUEST_ERROR 書込 → FIN → 受信方向キャンセルの拒否フロー。既存の `sendRequestErrorAndCancel` (`src/session.ts`) は session 非依存 (stream / errorCode / reasonPhrase のみ) であるため、引数から session を除いた free function として `incoming.ts` に移設し、private メソッドは削除する (無呼び出しのデッドコードを残さない。doc コメントも移設先で更新)。
  - `incomingHandleFirstBidiMessage(session, stream, firstMsg): Promise<boolean>` — 3 分類のディスパッチ (async)。分類 2 は `incomingSendRequestErrorAndClose(stream, RequestErrorCode.NOT_SUPPORTED, "request type not supported")` を呼んで true を返し（固定文言の定義場所は `incomingHandleFirstBidiMessage` 内）、分類 3 は `session.closeWithError(...)` を呼んで true を返し、分類 1 は false を返して従来処理 (decode → サブスクリプション照合) を SessionImpl 側に委ねる。呼び出し側 (`handleIncomingBidirectionalStream`) は true なら return し、false なら従来の PUBLISH 処理を継続する。`SessionInternal` (`src/session/types.ts` の「抽出先 free function はこのインターフェースを引数に受け取る」設計) に整合させる。`closeWithError` は `BidiSessionInternal` に既存のため新規フィールド追加は不要。
  - `handleIncomingBidirectionalStream` は先頭メッセージ読取後に `incomingHandleFirstBidiMessage` を呼び、戻り値に応じて従来の PUBLISH 処理を継続する形に置き換える。`incoming.ts` のモジュール doc (「handleIncomingStream / handleSubgroupStream は SessionImpl に残留する」) に、受信 bidi ストリームの先頭ディスパッチを抽出した旨を追記する。
- **FIN でのストリームクローズ**: 分類 2 の応答は §3.3.3 の「When an endpoint rejects a request without performing any application processing, it SHOULD send a REQUEST_ERROR and FIN the stream.」と §10.19 の「If it is an error, the stream will be closed via FIN after REQUEST_ERROR is sent.」に従い、REQUEST_ERROR を送信した後に送信方向を FIN (`writer.close()`) で閉じる。**配置の制約**: finally の `writer.releaseLock()` の前に、try ブロック内 (write の直後) で `await writer.close()` を実行する。releaseLock 後の `close()` は WHATWG Streams 仕様 (`WritableStreamDefaultWriter.close()`) 上、ロック非保持時に TypeError で reject する Promise を返す (同期 throw ではない) ため、try 内で `await` し catch で吸収する。受信方向 (`readable`) は従来どおり `cancel()` で閉じる (FIN 送信後。§3.3.3 の「An endpoint that has already sent a FIN on its sending direction and subsequently wishes to cancel sends STOP_SENDING on the receiving direction.」に整合)。この拡張は既存の呼び出し 2 箇所 (受信 PUBLISH の UNSUPPORTED_EXTENSION / UNINTERESTED 応答、`handleIncomingBidirectionalStream` 内) にも波及し、両者も §3.3.3 準拠の FIN 付きクローズに統一される (両経路とも `incomingSendRequestErrorAndClose` 直後に return するため二重使用はない)。
- **先頭メッセージの読取範囲**: 分類の判定に必要なのは Type のみであり、Body 全体の到着を待たずにディスパッチできる。ただし `ControlStreamReader.feed()` は完全なメッセージを返すまで待つ既存構造のため、本 issue では「Body 全体を読んでから分類 2 / 3 を適用する」現行の読取方式を維持する (Body 全量バッファリングの無駄と未完ピアによるストリーム握りのリスクは既存挙動の継続として許容し、ヘッダー読了時点での早期ディスパッチはスコープ外とする)。
- **アプリケーションへの通知は行わない**: 受信 SUBSCRIBE 等のリクエストは対応 (履行) せず、アプリケーションへの通知も行わない (クライアント専用ライブラリとしての現状維持)。REQUEST_ERROR の応答送信自体は行う。
- **reasonPhrase**: NOT_SUPPORTED 応答の Reason Phrase は「request type not supported」を固定で指定する (テストで送信バイト列を検証するため固定する。Reason Phrase は wire 上のフィールドでありログではないため、英語規約は適用対象外)。Retry Interval は 0n (既存挙動どおり。§10.6.2 の「If the value is 0, the request SHOULD NOT be retried」に整合)。
- **制御ストリーム上の未知メッセージタイプ**: §10 序文の unknown message type MUST close の規定 (「An endpoint that receives an unknown message type MUST close the session.」) は、request stream の先頭メッセージについては §3.3 の PROTOCOL_VIOLATION が根拠となる。制御ストリーム上の未知タイプの扱い (既存実装、`src/session.ts` の `handleControlMessage` の default 分岐) は変更しない。
- **スコープ外の明示**: 受信 SUBSCRIBE_TRACKS が NOT_SUPPORTED で閉じられるようになるため、issue 0389 (受信 SUBSCRIBE_TRACKS のパラメータ検証) の受信側検証は順序に関わらず到達不能になる。唯一の解は 0389 の完了条件を受信側検証を前提としない形に調整することであり、0389 側で対応する (0371 自体のスコープ外)。なお 0389 の受信側検証パスは現状も未構築 (6 種のリクエストデコーダは `src/message/index.ts` の re-export のみで production 未使用) であり、「0371 実装後に到達不能になる」のではなく「現状も存在しない」点に注意する。同じ決定を共有する issue 0388 (parameterScope 未使用定数整理) は、`SUBSCRIBE_TRACKS_ALLOWED_PARAMS` の配線が不可能になるため「削除」に収束する。issue 0375 (受信 .session namespace 拒否) は受信 PUBLISH の `.session` 拒否が主目的であり、受信 PUBLISH は分類 1 で継続処理されるため主目的のパスは残るが、0375 の完了条件に「非 PUBLISH リクエストへの DOES_NOT_EXIST (§3.2.2) は 0371 実装後は NOT_SUPPORTED が先に適用される (判定順序は型分類が先)」旨の注記が必要である。なお §3.2.2 の DOES_NOT_EXIST MUST と §4 の NOT_SUPPORTED SHOULD の優先順位は draft が定義しておらず、NOT_SUPPORTED が先に適用されるのは 0371 の 3 分類の判定順序による解釈であり、残余リスクとして明示する。issue 0381 (受信 Request ID パリティ・重複検証) は `handleIncomingBidirectionalStream` を変更対象としており、0371 実装後は分類 2 の 6 種がペイロードをデコードしないため、0381 のパリティ・重複検証は分類 1 (受信 PUBLISH) のみに適用される。0381 の完了条件 (「LSB が期待値と一致しない Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること」「重複 Request ID を受信した場合に INVALID_REQUEST_ID でセッションが閉じること」) は 6 種では発火しないため、0381 側に「検証対象は受信 PUBLISH のみ」の注記と完了条件の調整が必要である。あわせて、分類 2 の 6 種では §10.1 の MUST (INVALID_REQUEST_ID) が未達のまま残ることも残余リスクとして明示する。issue 0378 (Message Body 長一致検証) は `src/message/*.ts` のデコーダ群が対象であり `handleIncomingBidirectionalStream` とはコード競合しないが、0371 実装後は分類 2 の 6 種がデコードされないため、0378 の受信経路での Body 長検証も 6 種では発火しない (デコーダ単体テストは対象外)。0378 側に同種の注記が必要である。issue 0377 (受信 PUBLISH の FORWARD 反映) は同じ `handleIncomingBidirectionalStream` の分類 1 内を変更対象とするため直接の競合はないが、0377 の行番号参照 (`src/session.ts:3368-3396`) は 0371 の構造変更でずれるため、0377 側に「行番号参照を `handleIncomingBidirectionalStream` 内のシンボル名に書き換える」旨の注記をする。0371 の変更で `sendRequestErrorAndCancel` の削除と `handleIncomingBidirectionalStream` の分岐差し替えにより session.ts の行がドリフトするため、session.ts を行番号参照している 0372 (`runPublishStreamSubLoop` の GOAWAY ケース) / 0374 (`runPublishStreamSubLoop` の FIN 検出点) / 0381 (受信側の行番号参照) にも、同様に「行番号参照をシンボル名に書き換える」旨の注記をする。issue 0370 (PUBLISH_OK 後にピアが FIN すると PUBLISH_DONE が送信されない) との調整は完了条件に記載する (0371 のテスト方式は 0370 のテスト方式と同型だが、0370 のコードには依存しない)。これらの他 issue への注記は、0371 の実装者が対象 issue ファイルに直接追記し、完了条件に含める (注記追加を担う専用 doc issue は立てない)。
- **対応する既存コメントの更新**: `src/session.ts` の `handleIncomingBidirectionalStream` 付近の「PUBLISH 以外のメッセージタイプで始まる双方向ストリームは PROTOCOL_VIOLATION」コメントと doc コメントを、3 分類の実態に合わせて更新する。分類 3 で使用するエラー文言「expected PUBLISH as first message...」は 7 種以外のみに発火するため「expected a request message as first message on incoming bidirectional stream, got 0x...」等の内容に更新する。`src/session/incoming.ts` のモジュール doc の issue 番号参照（「issue 0302 設計方針参照」）の削除は別 issue 0399 で対応する（本 issue のモジュール doc 追記時には残存を許容する）。

## 完了条件

- 受信 bidi ストリームの先頭が分類 2 の 6 種の場合、セッションを閉じず REQUEST_ERROR (NOT_SUPPORTED) を応答し、送信方向を FIN (`writer.close()`) で閉じること (§3.3.3 / §10.19)。FIN は releaseLock の前に配置し、受信方向は `cancel()` で閉じること。
- 受信 bidi ストリームの先頭が 7 種以外 (未知タイプ等) の場合、従来どおり PROTOCOL_VIOLATION でセッションが閉じること (§3.3 MUST)。
- PUBLISH が先頭の場合は従来どおり処理されること。
- 上記を検証するテストがあること。テストは `incomingClassifyFirstBidiMessage` / `incomingSendRequestErrorAndClose` / `incomingHandleFirstBidiMessage` を `src/session/incoming.test.ts` に新設して検証する (session 内のテスト対象モジュールは `incoming.ts` となるため、既存 `bidi.test.ts` とは分離して `incoming.ts` の free function (新設 3 関数) のテストを集約する。既存 `bidi.test.ts` のテスト移動は伴わない。受信ストリームの注入は Node 22+ のグローバル W3C ストリーム (`ReadableStream` / `WritableStream`) を `as unknown as WebTransportBidirectionalStream` で注入する方式で、0370 が新設する方式と同型である。0370 のコードには依存しないため、実装順序の制約はない。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外)。検証項目:
  1. 分類 2 で REQUEST_ERROR (NOT_SUPPORTED) が書き込まれ `writer.close()` が呼ばれ、`session.closeWithError` が呼ばれないこと。
  2. 分類 3 で `session.closeWithError(PROTOCOL_VIOLATION)` が呼ばれること。
  3. 分類 1 で false が返り SessionImpl 側の従来処理 (decode 成功まで) が継続されること (free function の契約として false 返却を検証し、decode 以降の継続は `handleIncomingBidirectionalStream` の既存コードパスを変更しないことで担保する)。
  4. 既存 2 パス (UNSUPPORTED_EXTENSION / UNINTERESTED) でも `writer.close()` が呼ばれること (共有ヘルパー移設の回帰検証)。ただしこの 2 経路は `handleIncomingBidirectionalStream` (SessionImpl の private メソッド) 内に残留するコードパスであり、free function 単体テストでは到達不能なため、`handleIncomingBidirectionalStream` 内の 2 経路が `incomingSendRequestErrorAndClose` を呼ぶ配線はコードレビューで担保する (0373 の「runPublishStreamSubLoop 内の配線はコードレビューで担保する」と同様の扱い)。
- 他 issue への注記が追加されていること（注記対象はファイルパスで特定する。番号のみだと closed 側の同名番号 issue（0375 / 0376 / 0377 は closed に同名番号が存在）と衝突して誤るため）: `issues/0389-moqt-draft-19-subscribe-tracks-allowed-params-unwired.md` (完了条件の調整)、`issues/0388-moqt-draft-19-parameter-scope-unused-constants.md` (「削除」に収束)、`issues/0375-moqt-draft-19-session-level-namespace-not-rejected.md` (NOT_SUPPORTED が先に適用される旨)、`issues/0381-moqt-draft-19-request-id-parity-validation.md` (検証対象は受信 PUBLISH のみ + §10.1 未達の残余リスク + 行番号参照のシンボル名化)、`issues/0378-moqt-draft-19-message-body-length-validation.md` (受信経路では発火しない旨)、`issues/0377-moqt-draft-19-publish-forward-param-not-applied.md` (行番号参照をシンボル名に書き換える旨)、`issues/0372-moqt-draft-19-duplicate-goaway-on-request-stream-undetected.md` / `issues/0374-moqt-draft-19-fin-without-publish-done-not-notified.md` (session.ts 行番号参照のシンボル名化)、`issues/0390-moqt-draft-19-unexport-internal-symbols.md` (`incomingClassifyFirstBidiMessage` の export 維持。理由: 同関数は `incoming.ts` 内部と `incoming.test.ts` からのみ参照され、session.ts から直接 import されない可能性が高いため)。注記の実施主体は本 issue (0371) の実装者とする。
- 後方互換: 公開 API は変更しない。動作変化は「未対応リクエスト受信時にセッション終了とアプリへのエラー通知 (`closeWithError` → `callbacks.error`) が行われなくなり、代わりに REQUEST_ERROR (NOT_SUPPORTED) が応答される」「既存の UNSUPPORTED_EXTENSION / UNINTERESTED 応答でも FIN が送信されるようになる」の 2 点。CHANGES.md の種別はこの挙動変化 (通知消失を含む) を踏まえ `[FIX]` とする。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.2.2 (Session-Level Tracks and Namespaces / DOES_NOT_EXIST)
- draft-ietf-moq-transport-19 §3.3 (Session initialization / 先頭メッセージ 7 種と MUST close)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / REQUEST_ERROR + FIN の SHOULD)
- draft-ietf-moq-transport-19 §4 (Extensibility / NOT_SUPPORTED 応答の SHOULD)
- draft-ietf-moq-transport-19 §9.5 (Publisher Interactions / リレーからの SUBSCRIBE)
- draft-ietf-moq-transport-19 §10 序文 (unknown message type MUST close the session)
- draft-ietf-moq-transport-19 §10.1 (Request ID / INVALID_REQUEST_ID)
- draft-ietf-moq-transport-19 §10.6 (REQUEST_ERROR)
- draft-ietf-moq-transport-19 §10.6.2 (REQUEST_ERROR Message Format / NOT_SUPPORTED 定義)
- draft-ietf-moq-transport-19 §10.12 (Joining Fetch / リレーからの FETCH)
- draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS / REQUEST_ERROR 後の FIN)
- 関連: `issues/closed/0317-bug-subscribe-tracks-publish-reception.md`（`handleIncomingBidirectionalStream` の PUBLISH 以外 PROTOCOL_VIOLATION 分岐と `sendRequestErrorAndCancel` の新設元）

## 解決方法

- `src/session/incoming.ts` に `incomingClassifyFirstBidiMessage` / `incomingSendRequestErrorAndClose` / `incomingHandleFirstBidiMessage` を新設。
  - `incomingClassifyFirstBidiMessage`: 先頭メッセージを publish / unsupported-request / protocol-violation の 3 分類。
  - `incomingSendRequestErrorAndClose`: REQUEST_ERROR 書込 → FIN (writer.close()) → 受信方向 cancel の拒否フロー。既存の `sendRequestErrorAndCancel` を移設し、FIN 付きに統一。
  - `incomingHandleFirstBidiMessage`: 3 分類のディスパッチ。分類 2 は NOT_SUPPORTED 応答でセッション維持、分類 3 は PROTOCOL_VIOLATION、分類 1 は false を返して従来処理へ。
- `src/session.ts` の `handleIncomingBidirectionalStream`: 先頭メッセージの「PUBLISH 以外は PROTOCOL_VIOLATION」分岐を 3 分類ディスパッチに置き換え。UNSUPPORTED_EXTENSION / UNINTERESTED の 2 経路も `incomingSendRequestErrorAndClose` に統一。`sendRequestErrorAndCancel` を削除。
- テスト: `src/session/incoming.test.ts` を新設 (9 件)。3 分類の全経路、NOT_SUPPORTED 応答のバイト列、FIN / cancel の呼び出し順序、write / close 失敗時の受信方向キャンセルを実 W3C ストリーム注入方式で検証。
- 他 issue への相互参照注記を 7 件追加 (0372 / 0374 / 0377 / 0381 / 0388 / 0389 / 0390。0375 / 0378 は既に注記済み)。
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加。
- `vp check` / `tsc --noEmit` / `vp test run` (997 件) すべて通過。
