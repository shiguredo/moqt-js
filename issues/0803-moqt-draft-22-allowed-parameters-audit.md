# 制御メッセージごとの許可パラメータ一覧を監査する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-allowed-parameters-audit
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §9.20.1 (Parameter Scope) は、v21 の同節には無かった「各制御メッセージの定義が許可パラメータを列挙する」という規定を追加した。逐語は "Each Message Parameter definition indicates the message types in which it can appear, and each control message definition lists the parameters it allows." である。v22 ではパラメータを持つ各制御メッセージ節が許可パラメータを明文列挙し（Appendix A の「List the allowed parameters in each control message (#1916)」)、v21 の §9.20.2 (Allowed Parameters By Control Message) の表は廃止された。廃止に伴い、パラメータ節は v21 の §9.20.3〜§9.20.22 から v22 の §9.20.2〜§9.20.21 へ番号が 1 つずつ繰り下がる（v22 の §9.20.2 は AUTHORIZATION TOKEN Parameter になった）。

moqt-js は `src/message/parameterScope.ts` に許可集合を持ち、受信時は `validateParameterScope`、REQUEST_UPDATE 送信時は `assertParametersAllowedForSend` で検証しているが、コメントの節番号は v21 のままである。集合・`FILL_PARAMETERS_ALLOWED_TYPES`・各 build 関数の内容を v22 の一覧と突き合わせ、差分を修正し、参照を v22 に更新する。

v22 のメッセージ別許可一覧（パラメータを持たないのは §9.9 PUBLISH_DONE / §9.16 NAMESPACE / §9.17 NAMESPACE_DONE / §9.19 PUBLISH_SKIPPED）:

- SUBSCRIBE (§9.6): OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / RENDEZVOUS_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / FILL_PARAMETERS / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / NEW_GROUP_REQUEST / INCLUDE_PROPERTIES
- SUBSCRIBE_OK (§9.7): EXPIRES / LARGEST_OBJECT
- PUBLISH (§9.8): OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / SUBGROUP_DELIVERY_TIMEOUT / EXPIRES / LARGEST_OBJECT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER
- PUBLISH_STATE_NOTIFY (§9.10): LARGEST_OBJECT / FORWARD / LOCATION_FILTER
- FETCH (§9.11): AUTHORIZATION_TOKEN / FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / INCLUDE_PROPERTIES
- FETCH_OK (§9.12): パラメータ無し
- TRACK_STATUS (§9.13): AUTHORIZATION_TOKEN / INCLUDE_PROPERTIES
- PUBLISH_NAMESPACE (§9.14): AUTHORIZATION_TOKEN のみ
- SUBSCRIBE_NAMESPACE (§9.15): AUTHORIZATION_TOKEN のみ
- SUBSCRIBE_TRACKS (§9.18): AUTHORIZATION_TOKEN / FORWARD / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER / INCLUDE_PROPERTIES
- REQUEST_UPDATE (§9.5): 更新対象ごとに異なる
  - Subscription: OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / SUBGROUP_DELIVERY_TIMEOUT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / FILL_PARAMETERS / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / NEW_GROUP_REQUEST
  - FETCH: AUTHORIZATION_TOKEN / SUBSCRIBER_PRIORITY
  - PUBLISH_NAMESPACE: AUTHORIZATION_TOKEN
  - SUBSCRIBE_NAMESPACE: AUTHORIZATION_TOKEN / TRACK_NAMESPACE_PREFIX
  - SUBSCRIBE_TRACKS: AUTHORIZATION_TOKEN / FORWARD / TRACK_PROPERTY_FILTER / TRACK_NAMESPACE_PREFIX

FILL_PARAMETERS 内側 (§9.20.15 Table 7): FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER（TRACK_PROPERTY_FILTER を含まない。v21 では Table 6）

注意: SUBSCRIBE_TRACKS は v21 の §9.18.1（v22 では §3.6.2 へ移動）が「SUBSCRIBE に指定できるパラメータはすべて SUBSCRIBE_TRACKS でも有効（特に指定が無い限り）」と定めていた。v22 §3.6.2 にも同文言と「Location Filter / FILL_PARAMETERS を SUBSCRIBE_TRACKS に指定できる」との併記が残っており、§9.18 の一覧（9 種）と矛盾する。本 issue では §9.20.1 の MUST（許可外メッセージへの出現は受信側で PROTOCOL_VIOLATION）と §9.18 の列挙、各パラメータ定義（§9.20.7 / §9.20.9 / §9.20.15 は SUBSCRIBE_TRACKS を挙げない）を正とみなす。この仕様内部の矛盾は実装コメントに記録する。

## 現状

許可集合は `src/message/parameterScope.ts` にある。受信検証（`validateParameterScope`）は SUBSCRIBE_OK / PUBLISH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK / NAMESPACE_OK / FETCH_OK / 受信 PUBLISH / 受信 REQUEST_UPDATE、送信ガード（`assertParametersAllowedForSend`）は subscription 系 REQUEST_UPDATE / namespace 系 REQUEST_UPDATE に使う。

- v22 の一覧と一致する集合:
  - `SUBSCRIBE_OK_ALLOWED_PARAMS` {EXPIRES, LARGEST_OBJECT}（§9.7）
  - `PUBLISH_OK_ALLOWED_PARAMS` {EXPIRES}（§9.20.16）
  - `REQUEST_UPDATE_OK_ALLOWED_PARAMS` {LARGEST_OBJECT, EXPIRES}（§9.20.16 / §9.20.17）
  - `PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS` {LARGEST_OBJECT, FORWARD, LOCATION_FILTER}（§9.10）
  - `TRACK_STATUS_OK_ALLOWED_PARAMS` {LARGEST_OBJECT}（§9.20.17。§9.13 が「SUBSCRIBE_OK と同じ parameters」と述べる点との対立は、EXPIRES を除外する判断として doc に記録済み。v22 でも文言は同様のため判断を維持する）
  - `NAMESPACE_OK_ALLOWED_PARAMS` {EXPIRES}（§9.20.16 は SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK を挙げる）
  - `REQUEST_UPDATE_ALLOWED_PARAMS`（§9.5 の Subscription 向け一覧 12 種と一致。GROUP_ORDER / TRACK_NAMESPACE_PREFIX / TRACK_PROPERTY_FILTER / EXPIRES を含まないことも §9.20.8 / §9.20.20 / §3.3.2 / §9.20.16 と一致）
  - `PUBLISH_ALLOWED_PARAMS`（9 種、§9.8 と一致）
  - `FETCH_OK_ALLOWED_PARAMS` 空集合（§9.12）
- v22 の一覧と一致しない集合:
  - `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` = {TRACK_NAMESPACE_PREFIX, AUTHORIZATION_TOKEN, FORWARD}。v22 §9.5 の SUBSCRIBE_TRACKS 向け REQUEST_UPDATE は TRACK_PROPERTY_FILTER (0x29) も許可するため、1 型足りない
- `src/message/parameter/messageParameter.ts` の `FILL_PARAMETERS_ALLOWED_TYPES` は Table 7 と一致し、TRACK_PROPERTY_FILTER (0x29) を含まない（コメントの節番号・Table 番号は v21 のまま: §9.20.16 Table 6）
- SUBSCRIBE / FETCH / SUBSCRIBE_TRACKS / TRACK_STATUS / SUBSCRIBE_NAMESPACE / PUBLISH_NAMESPACE には許可集合が無い。送信側は build 関数と型付き options でパラメータを構築しており、受信側は `incomingClassifyFirstBidiMessage` が 6 種を unsupported-request（REQUEST_ERROR NOT_SUPPORTED 応答）に分類するため、受信許可集合も持たない（クライアント専用の意図的な欠落）
- `src/session/params.ts` の `buildSubscribeTracksParameters` は LOCATION_FILTER（options.filter）/ SUBSCRIBER_PRIORITY（options.subscriberPriority）/ FILL_PARAMETERS（options.fill）を送り得る。これは v21 §9.18.1 の読み方（SUBSCRIBE と同じ）に基づくもので、v22 §9.18 の一覧からはみ出す（この 3 種はいずれも §9.20.9 / §9.20.7 / §9.20.15 のパラメータ定義にも SUBSCRIBE_TRACKS が挙がっていない）。`SubscribeTracksOptions` は filter / subscriberPriority / fill を公開している
- 節番号参照は v21 のまま。例: `parameterScope.ts` は FORWARD を §9.20.19、TRACK_NAMESPACE_PREFIX を §9.20.21、EXPIRES を §9.20.17 と書く。v22 ではそれぞれ §9.20.18 / §9.20.20 / §9.20.16。同様の v21 参照は `src/message/parameter/messageParameter.ts`（`MESSAGE_PARAMETER_VALUE_ENCODING` / `FILL_PARAMETERS_ALLOWED_TYPES`）、`src/message/types.ts`（`MessageParameterType` のコメント）、`src/message/parameter/rangeFilter.ts`、`src/message/parameter/common.ts`、`src/message/parameter/trackNamespace.ts`、`src/message/parameter.ts`、`src/message/fetch.ts`、`src/message/trackstatus.ts`、`src/filter.ts`、`src/error.ts`、`src/index.ts`、`src/session/params.ts`、`src/session/publicTypes.ts`、`src/session/bidi.ts`、`src/session/requests.ts`、`src/session/namespaceLoops.ts`、`src/session/incomingPublish.ts`、`src/session/namespaces.ts`、`src/session/stream.ts`、`src/session/authTokenCache.ts`、`src/publisher.ts`、`src/subscriber.ts`、`src/fetcher.ts`、`src/createMediaPublisher.ts`、`src/createMediaSubscriber.ts` と、テストでは `parameterScope.test.ts` / `params.test.ts` / `parameter.test.ts` / `parameter.prop.ts` / `parameterArb.ts` / `session.prop.ts` / `session.test.ts` / `subscriber.test.ts` / `publisher.test.ts` / `filter.prop.ts` / `filter.test.ts` などの §9.20 引用に存在する
- LOCATION_FILTER（v21 の §9.20.10、v22 では §9.20.9）の参照更新は 0796（ワイヤ形式変更。`src/filter.ts` と `src/message/fetch.ts` の §9.20 引用はすべて LOCATION_FILTER のため 0796 対象）、FORWARD（v21 の §9.20.19、v22 では §9.20.18）の用語・参照は 0800、LARGEST_OBJECT（v21 の §9.20.18、v22 では §9.20.17）の到着中前提は 0804、§9.18.1 → §3.6.2 などの参照更新は 0797 が担当するため、本 issue では重複して触らない

## 設計方針

- v22 の正とみなす資料: §9.5〜§9.19（メッセージ別許可一覧）/ §9.20.1〜§9.20.21（パラメータ定義）/ §3.3.2（Range Filters）。§3.6.2 の「SUBSCRIBE と同じ」との矛盾は、§9.20.1 の MUST（許可外メッセージへの出現は受信側が PROTOCOL_VIOLATION で閉じる）と §9.18 の列挙・各パラメータ定義を優先する
- 監査手順:
  1. v22 のメッセージ別一覧（目的に記載）からメッセージ × 許容パラメータの対応表を作る
  2. `parameterScope.ts` の全集合を対応表と照合する
  3. `FILL_PARAMETERS_ALLOWED_TYPES` を §9.20.15 Table 7 と照合する
  4. `buildSubscribeParameters` / `buildFetchParameters` / `buildPublishParameters` / `buildSubscribeTracksParameters` / `buildTrackStatusParameters` / `buildSubscribeNamespaceParameters` / `buildFillParameters` が各メッセージの一覧からはみ出さないかを照合する
  5. `validateParameterScope` / `assertParametersAllowedForSend` の適用経路を確認し、未適用のメッセージ（SUBSCRIBE / FETCH など）について型と build 関数で担保されていることを確認する
  6. 監査結果（差分とその処理）を「## 解決方法」に記録する
- SUBSCRIBE_TRACKS の修正: `buildSubscribeTracksParameters` と `SubscribeTracksOptions` から filter / subscriberPriority / fill を取り除く（§9.18 の一覧外のため。後方互換のない変更）。join したい Track は SUBSCRIBE / FETCH、または結果 PUBLISH を受信した後の REQUEST_UPDATE で指定する（§3.6.2 も "REQUEST_UPDATE following PUBLISH_OK" を併記している）。§3.6.2 との矛盾（Location Filter / FILL_PARAMETERS を SUBSCRIBE_TRACKS に指定できると読める記述）は `buildSubscribeTracksParameters` のコメントに残す。0796 が `buildSubscribeTracksParameters` の LOCATION_FILTER エンコードも対象にしているため、どちらが先に実装されても最終形が filter なしになる前提で整合させる
- `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` に TRACK_PROPERTY_FILTER (0x29) を追加する（§9.5 の SUBSCRIBE_TRACKS 向け許可に合わせる。公開 API（`TracksUpdateOptions`）には trackPropertyFilter を追加しないため挙動は変わらない）
- 参照の更新: パラメータ節を v22 へ（-1）、FILL_PARAMETERS の Table 6 → Table 7、§9.20.1 の逐語（"If it appears ..." → "If a parameter appears ..."）を v22 に合わせる。LOCATION_FILTER（v22 では §9.20.9）/ FORWARD（v22 では §9.20.18）/ LARGEST_OBJECT（v22 では §9.20.17）の参照は 0796 / 0800 / 0804 に、§9.18.1 → §3.6.2 などは 0797 に委譲する
- テスト: `parameterScope.test.ts`（`NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` に TRACK_PROPERTY_FILTER が含まれること、既存のスコープ検証の固定）、`params.test.ts`（SUBSCRIBE_TRACKS から filter / subscriberPriority / fill が送られないことの固定、TRACK_PROPERTY_FILTER 付き SUBSCRIBE_TRACKS が残ること、`buildSubscribeTracksParameters` の既存テストの参照更新）。変更に伴い参照する節番号・Table 番号を修正するテスト・コメント（`parameter.prop.ts` / `session.prop.ts` / `parameterArb.ts` など）も照合して更新する
- TRACK_STATUS_OK の EXPIRES 除外判断と `incomingClassifyFirstBidiMessage` の NOT_SUPPORTED 分類は変更しない（根拠は現状の doc にあり、v22 でも妥当）

## 完了条件

- 監査結果（メッセージ × 許容パラメータの対応表と、差分の判断）が「## 解決方法」に記録されている
- 節番号参照が v22 に更新されている（0796 / 0797 / 0800 / 0804 の担当前提を除く）
- `buildSubscribeTracksParameters` / `SubscribeTracksOptions` が §9.18 の一覧と一致し、`NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` が §9.5 の SUBSCRIBE_TRACKS 向け許可を含む
- 更新した集合・build 関数の挙動がテストで固定されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.3.2 (Range Filters) / §3.6.2 (Parameters on SUBSCRIBE_TRACKS) / §9.5 (REQUEST_UPDATE) / §9.6〜§9.19 (各制御メッセージ) / §9.20.1 (Parameter Scope) / §9.20.2〜§9.20.21 (各パラメータ) / §9.20.15 (FILL PARAMETERS Parameter、Table 7)
- `src/message/parameterScope.ts`
- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` / `FILL_PARAMETERS_ALLOWED_TYPES` / `decodeFillParameters`
- `src/session/params.ts` の build 系関数
- `src/session/publicTypes.ts` の `SubscribeTracksOptions` / `SubscribeOptions` / `FetchOptions` / `TracksUpdateOptions`
- 関連 issue: 0796（LOCATION_FILTER）/ 0797（§3.6 参照）/ 0800（FORWARD 用語）/ 0804（LARGEST_OBJECT）

## 解決方法

draft-ietf-moq-transport-22 §9.5〜§9.19 / §9.20.1〜§9.20.21 と `refs/moq/draft-ietf-moq-transport-22.txt` を正として、§9.20 の節番号と制御メッセージごとの許可パラメータを監査した。

### 1. メッセージ別の許可パラメータの照合結果

| メッセージ | v22 の許可パラメータ | 実装 | 判断 |
| --- | --- | --- | --- |
| SUBSCRIBE (§9.6) | 15 種 (OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / RENDEZVOUS_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / FILL_PARAMETERS / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / NEW_GROUP_REQUEST / INCLUDE_PROPERTIES) | `buildSubscribeParameters` / `SUBSCRIBE_ALLOWED_PARAMS` | 一致 |
| SUBSCRIBE_OK (§9.7) | EXPIRES / LARGEST_OBJECT | `SUBSCRIBE_OK_ALLOWED_PARAMS` | 一致 |
| PUBLISH (§9.8) | 9 種 | `PUBLISH_ALLOWED_PARAMS` / `buildPublishParameters` | 一致 |
| PUBLISH_STATE_NOTIFY (§9.10) | LARGEST_OBJECT / FORWARD / LOCATION_FILTER | `PUBLISH_STATE_NOTIFY_ALLOWED_PARAMS` | 一致 |
| FETCH (§9.11) | 10 種 | `buildFetchParameters` / `FETCH_ALLOWED_PARAMS` | 一致 |
| FETCH_OK (§9.12) | パラメータ無し | `FETCH_OK_ALLOWED_PARAMS` (空) | 一致 |
| TRACK_STATUS (§9.13) | AUTHORIZATION_TOKEN / INCLUDE_PROPERTIES | `buildTrackStatusParameters` | 一致 |
| PUBLISH_NAMESPACE (§9.14) / SUBSCRIBE_NAMESPACE (§9.15) | AUTHORIZATION_TOKEN のみ | 各 build 関数 | 一致 |
| SUBSCRIBE_TRACKS (§9.18) | 9 種 (AUTHORIZATION_TOKEN / FORWARD / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / TRACK_PROPERTY_FILTER / INCLUDE_PROPERTIES) | `buildSubscribeTracksParameters` | **3 種を削除して一致させた** |
| REQUEST_UPDATE (§9.5) | 対象ごとの一覧 | `REQUEST_UPDATE_ALLOWED_PARAMS` / `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` | **TRACK_PROPERTY_FILTER を追加して一致させた** |
| FILL_PARAMETERS 内側 (§9.20.15 Table 7) | 8 種 (TRACK_PROPERTY_FILTER を含まない) | `FILL_PARAMETERS_ALLOWED_TYPES` | 一致 (変更なし) |

### 2. 挙動の変更 (SUBSCRIBE_TRACKS の許可パラメータ)

- §9.18 の列挙を正とし、`buildSubscribeTracksParameters` と `SubscribeTracksOptions` から LOCATION_FILTER / SUBSCRIBER_PRIORITY / FILL_PARAMETERS を削除した (§9.20.1 の MUST と各パラメータ定義 (§9.20.7 / §9.20.9 / §9.20.15) が SUBSCRIBE_TRACKS を挙げないため)
- §3.6.2 の「SUBSCRIBE に指定できるパラメータは SUBSCRIBE_TRACKS でも有効」と「Location Filter / FILL_PARAMETERS を指定できる」という記述との矛盾は仕様内部の問題であり、判断と根拠を `SubscribeTracksOptions` と `buildSubscribeTracksParameters` の JSDoc に記録した
- fill 内側の Range Filter を購読単位の上限合算から外した (`namespaces.ts`)。SUBSCRIBE_TRACKS は FILL_PARAMETERS を運ばないため
- 公開 API の変更 (`SubscribeTracksOptions` の 3 フィールド削除) は CHANGES.md の `[CHANGE]` に記録した

### 3. 参照の更新

- §9.20.2 (Allowed Parameters By Control Message) の廃止に伴い、パラメータ節の番号を 1 つ繰り下げた (v21 §9.20.3〜§9.20.22 → v22 §9.20.2〜§9.20.21)。FILL_PARAMETERS の内側の一覧は Table 6 → Table 7、§9.20.1 の逐語は v22 に合わせた
- 機械置換で混入した誤り (OBJECT_DELIVERY_TIMEOUT / LARGEST_OBJECT / FORWARD / LOCATION_FILTER / SUBSCRIBER_PRIORITY / NEW_GROUP_REQUEST / Range Filter の範囲 / Figure 番号) は `/review-diff-code` の 3 周で検出して修正した
- LOCATION_FILTER / FORWARD / LARGEST_OBJECT の参照は各担当 issue (0796 / 0800 / 0804) の前提を壊さないよう確認し、本 issue の範囲では §9.20.18 → §9.20.17 (LARGEST OBJECT) の更新も行った (0804 の作業と重複する場合は 0804 側で本ブランチの結果を前提にする)

### 4. テスト

- `src/message/parameterScope.test.ts`: `NAMESPACE_REQUEST_UPDATE_ALLOWED_PARAMS` が §9.5 の 4 型 (AUTHORIZATION_TOKEN / FORWARD / TRACK_PROPERTY_FILTER / TRACK_NAMESPACE_PREFIX) ちょうどであることを固定
- `src/session/params.test.ts` / `src/session/params.prop.ts`: SUBSCRIBE_TRACKS が §9.18 の一覧に無い型を送らないことを固定 (旧 subscriberPriority のテストを置き換え)
- `src/session.test.ts`: SUBSCRIBE_TRACKS の外側 Range Filter が上限を超えるとストリームを開かずに throw することを固定。fill 内側を前提とした 5 テストは機能削除に伴い削除した (fill 経路の検証は SUBSCRIBE 側に残る)

### 5. 検証

`vp check` (1284 files 整形 / 475 files lint・型エラーなし) / `tsc --noEmit` / `vp test run` (198 files / 3565 tests) が通る。
