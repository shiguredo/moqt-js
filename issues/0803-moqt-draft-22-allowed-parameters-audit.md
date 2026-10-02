# 制御メッセージごとの許可パラメータ一覧を監査する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-allowed-parameters-audit
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §9.20.1 は「各 Message Parameter の定義が出現可能なメッセージを示し、各制御メッセージの定義が許可パラメータを列挙する」ことを明記した。各メッセージ節 (§9.6〜§9.18) に許可パラメータの一覧が入り、パラメータ節は §9.20.2〜§9.20.21 に再採番された。

moqt-js は `src/message/parameterScope.ts` に許可集合を持ち、送受信で検証しているが、コメントの節番号は v21 のままである。集合の内容を v22 の一覧と突き合わせ、参照を更新する。

v22 の主な一覧:

- SUBSCRIBE (§9.6): OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / RENDEZVOUS_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / FILL_PARAMETERS / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / NEW_GROUP_REQUEST / INCLUDE_PROPERTIES
- SUBSCRIBE_OK (§9.7): EXPIRES / LARGEST_OBJECT
- PUBLISH (§9.8): OBJECT_DELIVERY_TIMEOUT / AUTHORIZATION_TOKEN / SUBGROUP_DELIVERY_TIMEOUT / EXPIRES / LARGEST_OBJECT / FORWARD / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER
- PUBLISH_STATE_NOTIFY (§9.10): LARGEST_OBJECT / FORWARD / LOCATION_FILTER
- FETCH (§9.11): AUTHORIZATION_TOKEN / FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER / INCLUDE_PROPERTIES
- FETCH_OK (§9.12): パラメータ無し
- TRACK_STATUS (§9.13): AUTHORIZATION_TOKEN / INCLUDE_PROPERTIES
- PUBLISH_NAMESPACE (§9.14): AUTHORIZATION_TOKEN のみ
- SUBSCRIBE_NAMESPACE (§9.15): AUTHORIZATION_TOKEN のみ
- SUBSCRIBE_TRACKS (§9.18 / §3.6.2): SUBSCRIBE と同じ (特に指定が無い限り)
- FILL_PARAMETERS 内側 (§9.20.15 Table 7): FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER / GROUP_ORDER / SUBGROUP_FILTER / OBJECTID_FILTER / PRIORITY_FILTER / OBJECT_PROPERTY_FILTER

## 現状

- `src/message/parameterScope.ts` の集合 (SUBSCRIBE_OK / PUBLISH_OK / REQUEST_UPDATE_OK / PUBLISH_STATE_NOTIFY / TRACK_STATUS_OK / NAMESPACE_OK / REQUEST_UPDATE / NAMESPACE_REQUEST_UPDATE / PUBLISH / FETCH_OK) は v22 の一覧と内容が一致している。FILL 内側の `FILL_PARAMETERS_ALLOWED_TYPES` も Table 7 と一致し、TRACK_PROPERTY_FILTER (0x29) を含まない
- GROUP_ORDER は REQUEST_UPDATE の許可集合に含まれない (v22 §9.20.8 は SUBSCRIBE / PUBLISH / SUBSCRIBE_TRACKS / FETCH / FILL 内側のみ)。RENDEZVOUS_TIMEOUT は SUBSCRIBE のみ、INCLUDE_PROPERTIES は SUBSCRIBE / TRACK_STATUS / FETCH / SUBSCRIBE_TRACKS のみで整合する
- 受信 SUBSCRIBE / FETCH は `incomingClassifyFirstBidiMessage` で NOT_SUPPORTED を返すため、それらの受信許可集合を持たない (クライアント専用の意図的な欠落)
- 節番号参照は v21 のまま。例: `parameterScope.ts` は FORWARD を §9.20.19、TRACK_NAMESPACE_PREFIX を §9.20.21、EXPIRES を §9.20.17 と書く。v22 ではそれぞれ §9.20.18 / §9.20.20 / §9.20.16
- `src/message/parameter/messageParameter.ts` / `src/session/params.ts` / `src/session/publicTypes.ts` の各パラメータコメントも v21 の節番号

## 設計方針

- 上記の一覧と `parameterScope.ts` / `messageParameter.ts` の `FILL_PARAMETERS_ALLOWED_TYPES` / 各 build 関数 (`buildSubscribeParameters` / `buildFetchParameters` / `buildPublishParameters` / `buildSubscribeTracksParameters` / `buildTrackStatusParameters` / `buildSubscribeNamespaceParameters` / `buildFillParameters`) を突き合わせ、対応を issue に記録する
- パラメータ節の参照を v22 に更新する (§9.20.2〜§9.20.21)
- 差分が見つかった場合は許可集合・送信ガードを修正し、`parameterScope.test.ts` / `params.test.ts` / `parameter.test.ts` を更新する
- SUBSCRIBE / FETCH の受信許可集合が無いのは受信自体が未対応のためであり、変更しない (理由をコメントに残す)

## 完了条件

- 突き合わせ結果が記録され、節番号参照が v22 に更新されている
- 差分があった場合は集合とテストが修正されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §9.6-§9.19 (各制御メッセージ) / §9.20.1 (Parameter Scope) / §9.20.2-§9.20.21 (各パラメータ) / §9.20.15 (FILL PARAMETERS) / §3.6.2 (SUBSCRIBE_TRACKS のパラメータ)
- `src/message/parameterScope.ts`
- `src/message/parameter/messageParameter.ts` の `MESSAGE_PARAMETER_VALUE_ENCODING` / `FILL_PARAMETERS_ALLOWED_TYPES`
- `src/session/params.ts` の build 系関数

## 解決方法

{未着手}
