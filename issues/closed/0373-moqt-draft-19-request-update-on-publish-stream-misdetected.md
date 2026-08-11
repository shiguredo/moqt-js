# 受信 PUBLISH ストリーム上の REQUEST_UPDATE を PROTOCOL_VIOLATION で誤検知する

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-11
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-request-update-on-publish-stream-misdetected
- Polished: 2026-08-06

## 目的

draft-ietf-moq-transport-19 §10.9 のケース 1「The sender of a request (SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE, SUBSCRIBE_NAMESPACE, SUBSCRIBE_TRACKS) can later send a REQUEST_UPDATE on the same bidi stream as the request to modify it.」を正しく処理する。現在は受信した PUBLISH ストリーム上で REQUEST_UPDATE を受信すると「unknown message type」として PROTOCOL_VIOLATION でセッションを閉じる。受信 PUBLISH は §10.19「SUBSCRIBE_TRACKS is not required for a publisher to send PUBLISH messages」により SUBSCRIBE_TRACKS 経由に限らず到達し得るため、タイトル・本文は「受信 PUBLISH ストリーム」一般として扱う。

## 優先度根拠

現状の実装は §10.9 ケース 1 で明示的に許可された合法メッセージ (受信 PUBLISH の publisher による REQUEST_UPDATE) を誤検知し、セッション全体を切断する。仕様準拠のピアと併用できないため、Medium。

## 現状

- `src/session.ts:3232-3237` (`runPublishStreamSubLoop`) で、PUBLISH_DONE / GOAWAY / REQUEST_OK / REQUEST_ERROR 以外のメッセージを「unknown message type on publish stream」として `closeWithError(PROTOCOL_VIOLATION)` する。REQUEST_UPDATE はこの分岐に該当する。
- closed issue 0337 (コミット 5b465fc) は `src/session/bidi.ts:704-708` に SUBSCRIBE ストリーム上の予期しない REQUEST_UPDATE → PROTOCOL_VIOLATION を実装した。session.ts 側は REQUEST_ERROR coalescing のみ変更され、受信 PUBLISH ストリーム上の REQUEST_UPDATE は範囲外として先送りされた (本 issue はそのフォローアップである)。
- 受信 PUBLISH の現在の到達経路は `matchPublishToSubscription` (session.ts:3362/3500) による SUBSCRIBE_TRACKS マッチ時のみであり、`runPublishStreamSubLoop` も session.ts:3466 の単一経路である。
- 変更対象ファイル: `src/session.ts` (`runPublishStreamSubLoop` への REQUEST_UPDATE ケース追加)、`src/session/bidi.ts` (free function の追加)、`src/message/parameterScope.ts` (無限定 3 種の Set 追加)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。注記先 (変更対象外): `issues/0377-*.md` (委譲注記)、`issues/0374-*.md` (相互注記)、`issues/0381-*.md` (Request ID 検証の調整注記)、`issues/0388-*.md` (新設定数の削除対象外注記)。

## 設計方針

- **REQUEST_UPDATE ケースの追加**: `runPublishStreamSubLoop` の「unknown message type on publish stream」分岐 (session.ts:3232-3237) の直前に REQUEST_UPDATE ケースを追加する。PUBLISH_DONE / GOAWAY / REQUEST_OK / REQUEST_ERROR の既存 4 分岐の挙動は変更しない (回帰ガード)。処理本体は `src/session/bidi.ts` に新設する free function `bidiHandlePublishRequestUpdate(session: BidiSessionInternal, requestId: bigint, payload: Uint8Array): Promise<void>` に実装し、`runPublishStreamSubLoop` の REQUEST_UPDATE case から呼ぶ。応答の書き込みは `session.requestStreams.get(publishRequestId).writer` 経由で行い、ControlStreamWriter でフレーミングする (session.ts:3438-3442 で登録済み。ループ存続中は削除されない)。既存の role=publish ハンドラ (bidi.ts:698-781。role=publish 相当は 711-780) は変更しない (回帰リスク回避のため。共通化は応答書き込みパターンの踏襲にとどめる)。応答の reasonPhrase は既存パターン踏襲 (NOT_SUPPORTED は「parameter not supported for request update」等) とし、`emitDebug("send", ...)` も既存ハンドラと同様に呼ぶ。
- **判定順序**: REQUEST_UPDATE を受信したら (1) GOAWAY 受信済みか確認 (`session.goawayReceivedOnRequestStreams.has(publishRequestId)`) → 受信済みなら REQUEST_ERROR (GOING_AWAY) で応答して終了 (0372 の共通方針。GOAWAY 後 + スコープ違反の同時発生時は GOING_AWAY を優先)、(2) パラメータスコープ検証 (下記)、(3) 文脈限定パラメータの含有確認 (下記)、(4) REQUEST_OK 応答。
- **パラメータスコープ検証**: 受信 REQUEST_UPDATE のパラメータは §10.2.1 (Parameter Scope) に従い検証する。スコープ違反 (許可されない文脈のパラメータ) は §10.2.1 の MUST により PROTOCOL_VIOLATION でセッションを閉じる (REQUEST_ERROR で応答しない。`validateParameterScope` の既存セマンティクスと整合)。スコープ検証には既存の `REQUEST_UPDATE_ALLOWED_PARAMS` (src/message/parameterScope.ts:85-100) をそのまま流用する ({無限定 3 種} ∪ {文脈限定 10 種} と完全一致)。検証後の分岐: 無限定 3 種のみ → REQUEST_OK、文脈限定を含む → REQUEST_ERROR (NOT_SUPPORTED)、許可集合外 (未知の型・REQUEST_UPDATE に出現不可の型) → スコープ検証で PROTOCOL_VIOLATION。
- **ケース 1 の許容パラメータ集合**: ケース 1 (publisher が自身の PUBLISH を更新) で REQUEST_OK で受理するパラメータは、§10.2 の各パラメータ定義が REQUEST_UPDATE を無限定で許可するか否かに基づく (moqt-js 内部の `PUBLISH_ALLOWED_PARAMS` ではなく、draft の定義が基準)。無限定で許可されるのは AUTHORIZATION_TOKEN (0x03, §10.2.2) / OBJECT_DELIVERY_TIMEOUT (0x02, §10.2.4) / SUBGROUP_DELIVERY_TIMEOUT (0x06, §10.2.3) の 3 つのみであり、これらは REQUEST_OK で受理する。判定用の集合 (例: `PUBLISH_REQUEST_UPDATE_OK_PARAMS`) は `src/message/parameterScope.ts` に新設する。文脈限定パラメータ (FORWARD (0x10) / LOCATION_FILTER (0x21) / SUBSCRIBER_PRIORITY (0x20) / NEW_GROUP_REQUEST (0x32) / TRACK_NAMESPACE_PREFIX (0x34) / Range Filters (0x25-0x29)) は「for a subscription」修飾子 (§10.2.9 / §10.2.17 / §5.1.3) の解釈に依存する。特に FORWARD は §10.2.17 で「REQUEST_UPDATE (for a subscription)」に許可されるが、§5.1 の状態機械は subscription の更新 (Forward State の更新を含む) を subscriber 側に割り当てており (§5.1「The subscriber can send PUBLISH_OK or REQUEST_UPDATE to update the Forward State」)、publisher 発 (ケース 1) での合法性は draft 内で曖昧である。本 issue では文脈限定パラメータを含む REQUEST_UPDATE は REQUEST_ERROR (NOT_SUPPORTED) で応答する (文脈限定パラメータの許可拡大は将来の issue の対応とする)。厳密な §10.2.1 解釈との関係は残余リスク (1) に記載する。
- **FORWARD の反映は 0377 に委譲**: 本 issue では FORWARD を含む REQUEST_UPDATE は REQUEST_ERROR (NOT_SUPPORTED) で応答するため、0377 (受信 PUBLISH の FORWARD 反映) との競合はない。0377 が実装された時点で、ケース 1 の FORWARD 受理と反映を 0377 のスコープとして追加する。その旨を 0377 側に注記する。
- **応答**: §10.9 の「The receiver of a REQUEST_UPDATE MUST respond with exactly one REQUEST_OK or REQUEST_ERROR message indicating if the update was successful, unless it is coalescing failed updates to produce just one REQUEST_ERROR for multiple REQUEST_UPDATE messages.」に従い、受信 REQUEST_UPDATE ごとに必ず 1 通を同一 bidi ストリーム上で応答する。REQUEST_ERROR のトリガとエラーコードは判定順序 (1)(3) のとおり: NOT_SUPPORTED (0x3) / GOING_AWAY (0x6)。REQUEST_OK の応答ペイロードは空 parameters / 空 trackProperties とする (既存の bidi.ts:743-752 と同様。LARGEST_OBJECT は本 issue のケース 1 では不要)。§10.9 の coalescing 例外 (複数の REQUEST_UPDATE をまとめて 1 通の REQUEST_ERROR で応答) は本 issue のスコープ外とする。
- **Request ID の扱い**: 受信 REQUEST_UPDATE の Request ID は `decodeRequestUpdatePayload` で読み取るだけで、応答 (REQUEST_OK / REQUEST_ERROR) には含めない (draft-19 §10.5 / §10.6.2 の REQUEST_OK / REQUEST_ERROR に Request ID フィールドは存在せず、応答は同一 bidi ストリーム上に書き込まれることでリクエストが特定される。既存 role=publish ハンドラと同様)。Request ID の受信側検証 (パリティ・重複) は本 issue のスコープ外とし、実装時に 0381 側へ REQUEST_UPDATE を含めるか否かを調整する (0371 は 0381 のスコープを「受信 PUBLISH のみ」に限定する注記を要求している)。
- **マージセマンティクス**: §10.9 の「If a parameter previously set on the request is not present in REQUEST_UPDATE, its value remains unchanged. There is no mechanism to remove a parameter from a request.」に従い、REQUEST_UPDATE はパラメータの累積更新として扱う (§5.1.3 は Range Filter に限り Length 0 による削除を許可する例外だが、本 issue は Range Filter を NOT_SUPPORTED で受理しないため関係しない)。moqt-js は受信 PUBLISH のパラメータを状態として保持しない (SubscriberImpl に反映しない) ため、マージ処理は行わず REQUEST_OK 応答のみ行う (受理しても適用しない accept-then-ignore の意味論乖離は残余リスク (3))。なお §2.5 の「Receivers SHOULD check that there are no unexpected duplicate parameters and close the session with PROTOCOL_VIOLATION」は、既存 role=publish ハンドラも検出していない pre-existing gap であり、本 issue ではスコープ外とする。
- **0372 との相互参照**: 0372 (リクエストストリーム上の重複 GOAWAY を検出できない) は同じ `runPublishStreamSubLoop` を変更対象とし、0372 は暫定対応として「GOAWAY 後の REQUEST_UPDATE は REQUEST_ERROR (GOING_AWAY) で応答するか無視する」を実装予定である。本 issue は 0372 を先に実装し、0372 の暫定 REQUEST_UPDATE 分岐は本 issue の REQUEST_UPDATE case 実装時に撤去・置換する (GOING_AWAY 応答は本 issue の判定順序 (1) が担うため、0372 の暫定分岐は冗長になる。0372 が「無視する」を実装した場合も同様に撤去する)。実装順序: 0370 → 0371 → 0372 → 0373 → 0374 (0390 はその後に実施。0372 側の「0370 → 0372 → 0374、その後 0390」に 0371 / 0373 を挿入したもので矛盾しない)。0372 の実装が subscriber ロールの GOAWAY 受信時に送信方向を `writer.close()` で閉じる場合、本 issue の GOING_AWAY 応答の書き込みは失敗しエッジケース (b) の黙殺に落ちる (無応答 = 0372 の委譲範囲「無視する」に収まる。残余リスク (5))。0374 も同じ `runPublishStreamSubLoop` を変更対象とするため、0374 側に相互注記を追加する。0371 による `sendRequestErrorAndCancel` の削除・移設で session.ts:3169 以降の行番号 (3232-3237 / 3193-3205 / 3438-3442) がドリフトするため、0373 側でも 0371 との行番号調整注記を入れる。なお `bidiHandlePublishRequestUpdate` は production (session.ts の `runPublishStreamSubLoop`) から import されるため、0390 (未使用 export の非公開化) の対象にはならない。また 0388 (parameterScope の未使用定数整理) が同じ `src/message/parameterScope.ts` を変更対象とするため、新設する `PUBLISH_REQUEST_UPDATE_OK_PARAMS` は free function から使用されること (0388 の削除対象外であること) を 0388 側に注記する。
- **MAX_REQUEST_UPDATES**: moqt-js は MAX_REQUEST_UPDATES を広告しないため §10.3.1.7 のデフォルト 0 = 無制限となり、受信側の TOO_MANY_REQUEST_UPDATES 発動条件は成立しない (0338 の決定により受信側の outstanding カウント + セッション切断は未実装のままとする)。送信側ガード (src/session/bidi.ts:864-875 の `bidiSendRequestUpdate` outstanding 超過 throw) は既存のまま維持する。
- **§10.9.1 の失敗時処理**: §10.9.1 (Updating Subscriptions) の失敗時条項 (PUBLISH_DONE UPDATE_FAILED / FETCH data stream リセット / NS・TRACKS の bidi クローズ) はすべて publisher (ピア) 側の義務であり、moqt-js が subscriber 役で受信 PUBLISH を処理する側には REQUEST_ERROR 応答以外の義務が生じない (0337 の現状セクションに既出)。スコープ外として明記する。
- **エッジケース**: (a) REQUEST_UPDATE のデコード失敗: free function `bidiHandlePublishRequestUpdate` 内で catch し、PROTOCOL_VIOLATION でセッションを閉じる。`runPublishStreamSubLoop` の外側 catch は ProtocolViolationError のみ変換する (IncompleteDataError は変換されず、セッションが開いたままストリーム読み取りが止まる) ため、free function 内での閉鎖が必要 (実装時のレビューで確定。当初設計の「ループ catch 伝播」から変更)。(b) 応答の書き込み失敗 (writer が閉じている等): free function 内の書き込み部分のみを try/catch で包んで吸収し、PROTOCOL_VIOLATION への昇格も `callbacks.error` の発火も行わない。`runPublishStreamSubLoop` の外側 catch (session.ts:3241-3252) は非 ProtocolViolationError で `callbacks.error` を発火するため、局所吸収が実際に必要 (既存 role=publish ハンドラの bidi.ts 側ループ catch (824-830) が非 ProtocolViolationError を無視する構造と同様の効果を狙う)。(c) SUBSCRIBE_TRACKS 応答ストリーム側 (namespaceLoops.ts:328 の「received second REQUEST_OK on tracks stream」ガード) の誤検知リスクは、本 issue の対象外として明記する (tracks ストリーム上の REQUEST_UPDATE 対応は別 issue の対応とする)。(d) PUBLISH_DONE 受信後の REQUEST_UPDATE: 同一チャンク内に連続する場合 (PUBLISH_DONE 直後の REQUEST_UPDATE) は for ループが while 条件の再評価をまたがずに後続メッセージを処理し続けるため REQUEST_UPDATE ケースに到達し応答が発生する (state は `bidiHandlePublishDone` → `subscriber.handleEnd()` で既に closed だが、while 条件は次チャンク読み取り時まで再評価されない)。後続チャンクの REQUEST_UPDATE は while 条件でループが終了するため黙殺される (§10.9 の MUST respond はリクエスト終端後には及ばない、という本 issue の解釈に基づく。チャンク境界依存で応答有無が分かれる挙動は残余リスク (6))。
- **残余リスク**: (1) 文脈限定パラメータの NOT_SUPPORTED 統一は §10.2.1 の厳格解釈 (PROTOCOL_VIOLATION) と緊張する設計判断である。パラメータにより緊張の度合いは異なる: (a) FORWARD (0x10) / LOCATION_FILTER (0x21) / SUBSCRIBER_PRIORITY (0x20) / NEW_GROUP_REQUEST (0x32) は「for a subscription」修飾でありケース 1 で充足され得るため NOT_SUPPORTED は許容範囲 (§4 の NOT_SUPPORTED SHOULD の趣旨と整合)、(b) TRACK_NAMESPACE_PREFIX (0x34) と Range Filters (0x25-0x29) はどの読みでも PUBLISH ストリーム上のケース 1 REQUEST_UPDATE に出現できず §10.2.1 の MUST (PROTOCOL_VIOLATION) からの逸脱が明確に生じる。実装着手前に §10.2.1 の該当節を精読し、(a)/(b) を分けて最終判定して確定すること。(2) 既存 role=publish ハンドラ (bidi.ts:712-780) は文脈限定パラメータを含む REQUEST_UPDATE を REQUEST_OK で受理する一方、新 free function は NOT_SUPPORTED で応答する非対称性がある (FORWARD は 0377 委譲で明記済み。それ以外の文脈限定パラメータも同様に分岐する)。(3) 受信 REQUEST_UPDATE の受理 (REQUEST_OK) はパラメータを適用しない accept-then-ignore であり、更新の反映を前提とするピアと意味論が乖離する。(4) `runPublishStreamSubLoop` 内の配線 (REQUEST_UPDATE case が unknown-message 分岐に落ちないこと) は private のため自動テスト対象外で、コードレビューでの担保が必須。(5) GOING_AWAY 応答は 0372 の subscriber ロール `writer.close()` 後は production で書き込み不能となり黙殺される。production での GOING_AWAY 到達性は 0372 のクローズ方針に依存し、単体テストで担保されるのは writer オープン時のみ。(6) エッジケース (d) の応答有無はチャンク境界 (transport の都合) に依存して分かれる。

## 完了条件

- 受信 PUBLISH ストリーム上で REQUEST_UPDATE を受信してもセッションが閉じず、REQUEST_OK または REQUEST_ERROR が同一 bidi ストリーム上で応答されること (§10.9 MUST。エッジケース (b) の書き込み失敗時・(d) の後続チャンク時は黙殺される)。
- パラメータスコープ違反の REQUEST_UPDATE は §10.2.1 の MUST に従い PROTOCOL_VIOLATION でセッションが閉じること (REQUEST_ERROR で応答しない。GOAWAY 受信後の同時発生時は判定順序 (1) により GOING_AWAY を優先する)。
- 文脈限定パラメータ (SUBSCRIBER_PRIORITY / FORWARD / LOCATION_FILTER / NEW_GROUP_REQUEST / TRACK_NAMESPACE_PREFIX / Range Filters (SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER)) を含む REQUEST_UPDATE は REQUEST_ERROR (NOT_SUPPORTED) で応答されること。
- GOAWAY 受信後で writer が利用可能な場合は REQUEST_ERROR (GOING_AWAY) で応答されること (0372 実装後に subscriber ロールの GOAWAY 受信で送信方向が `writer.close()` される場合、書き込みは失敗しエッジケース (b) の黙殺に落ちるため、この完了条件は free function 単体テストで writer オープン時に検証する。production での GOING_AWAY 応答到達性は 0372 のクローズ方針に依存する。残余リスク (5))。
- 上記を検証するテストがあること。テストは `runPublishStreamSubLoop` が private メソッド (session.ts:3169) のため、新設する free function `bidiHandlePublishRequestUpdate` を `src/session/bidi.test.ts` から直接呼んで検証する (writer 側に実 W3C ストリームを注入し、`session` は 0370 の実ストリーム注入方式と同様に `as unknown as BidiSessionInternal` で構築する。reader 注入は不要。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外)。検証項目: 無限定 3 種のみを含む REQUEST_UPDATE で REQUEST_OK が応答されセッションが閉じないこと / スコープ違反で PROTOCOL_VIOLATION が発生すること / 文脈限定パラメータを含む場合に REQUEST_ERROR (NOT_SUPPORTED) が応答されること / GOAWAY 受信後 (writer オープン時) の REQUEST_UPDATE に REQUEST_ERROR (GOING_AWAY) が応答されること。`runPublishStreamSubLoop` 内の配線 (REQUEST_UPDATE case が unknown-message 分岐に落ちないこと、既存 4 分岐が無変更であること) は free function 単体テストでは検証できないため、コードレビューで担保する。
- 後方互換: 公開 API は変更しない。挙動変化は「受信 PUBLISH ストリーム上で REQUEST_UPDATE を受信してもセッションが閉じず、REQUEST_OK / REQUEST_ERROR が応答される」の 1 点 (スコープ違反の PROTOCOL_VIOLATION は現状と同じ挙動の維持)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §2.5 (Message Parameters / 未知パラメータは PROTOCOL_VIOLATION / 重複パラメータ検出 SHOULD)
- draft-ietf-moq-transport-19 §4 (REQUEST_ERROR NOT_SUPPORTED SHOULD)
- draft-ietf-moq-transport-19 §5.1 (Subscriptions / Forward State は subscriber 側で更新)
- draft-ietf-moq-transport-19 §5.1.3 (Range Filters / from the subscriber only は 0x25-0x28、0x29 は SUBSCRIBE_TRACKS 限定)
- draft-ietf-moq-transport-19 §10.2.1 (Parameter Scope / スコープ違反は PROTOCOL_VIOLATION)
- draft-ietf-moq-transport-19 §10.2.2 (AUTHORIZATION_TOKEN Parameter)
- draft-ietf-moq-transport-19 §10.2.3 (SUBGROUP_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-19 §10.2.4 (OBJECT_DELIVERY_TIMEOUT Parameter)
- draft-ietf-moq-transport-19 §10.2.9 (LOCATION_FILTER Parameter)
- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter)
- draft-ietf-moq-transport-19 §10.2.18 (NEW_GROUP_REQUEST Parameter)
- draft-ietf-moq-transport-19 §10.2.19 (TRACK_NAMESPACE_PREFIX Parameter)
- draft-ietf-moq-transport-19 §10.3.1.7 (MAX_REQUEST_UPDATES / デフォルト 0 = 無制限)
- draft-ietf-moq-transport-19 §10.9 (REQUEST_UPDATE / ケース 1・2 と MUST respond / マージセマンティクス)
- draft-ietf-moq-transport-19 §10.9.1 (Updating Subscriptions)
- draft-ietf-moq-transport-19 §10.19 (SUBSCRIBE_TRACKS)

## 解決方法

- `src/message/parameterScope.ts`: `PUBLISH_REQUEST_UPDATE_OK_PARAMS` (無限定 3 種: AUTHORIZATION_TOKEN / OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT) を新設した。
- `src/session/bidi.ts`: free function `bidiHandlePublishRequestUpdate` を新設した。判定順序は (1) GOAWAY 受信済み → REQUEST_ERROR (GOING_AWAY)、(2) パラメータスコープ検証 (§10.2.1、違反は PROTOCOL_VIOLATION で応答しない)、(3) 文脈限定パラメータ含有 → REQUEST_ERROR (NOT_SUPPORTED)、(4) REQUEST_OK。書き込み失敗は黙殺し、デコード失敗は free function 内で catch して PROTOCOL_VIOLATION でセッションを閉じる (ループ catch は ProtocolViolationError のみ変換するため。エッジケース (a) の実装時の変更)。
- `src/session.ts` (`runPublishStreamSubLoop`): 0372 の暫定「無視する」REQUEST_UPDATE 分岐を `bidiHandlePublishRequestUpdate` 呼び出しに撤去・置換した (GOING_AWAY 応答は本関数の判定順序 (1) が担う)。セッションが閉じた場合は同一チャンクの残りメッセージの処理を打ち切るガードを追加した。
- テスト: `src/session/bidi.test.ts` に 11 件追加した (無限定 3 種のみ → REQUEST_OK / パラメータ無し → REQUEST_OK / スコープ違反 → PROTOCOL_VIOLATION / 文脈限定パラメータ → REQUEST_ERROR (NOT_SUPPORTED) / 無限定 + 文脈限定の混合 → NOT_SUPPORTED / GOAWAY 受信後 → REQUEST_ERROR (GOING_AWAY) / GOAWAY 後 + スコープ違反の同時発生 → GOING_AWAY 優先 / 応答書き込み失敗の黙殺 / GOING_AWAY 書き込み失敗の黙殺 / デコード失敗 → PROTOCOL_VIOLATION / requestStreams 非存在の requestId → 黙殺)。
- `CHANGES.md` の `## develop` に `[FIX]` エントリを追加した。
- 注記追加: `issues/0377` (FORWARD 受理・反映の委譲注記)、`issues/0374` (相互注記)、`issues/0388` (`PUBLISH_REQUEST_UPDATE_OK_PARAMS` の削除対象外注記)、`issues/0381` (受信 REQUEST_UPDATE の Request ID 検証の調整注記)。
- `vp check` / `tsc --noEmit` / `vp test run` (1013 件) すべて通過した。
