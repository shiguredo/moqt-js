# コメントと節番号参照を draft-21 に更新する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/update-draft-21-section-references
- Polished: {YYYY-MM-DD}

## 目的

`refs/moq/draft-ietf-moq-transport-21.txt` への更新に伴い、ソース・テスト・devtools・docs・README に残る draft-ietf-moq-transport-20 の版表記・節番号・図表番号・付録番号の参照を draft-21 に更新する。draft-21 は編集上の変更のみでワイヤ形式・エラーコード値・パラメータ型は不変のため、実装変更は含めない。

## 現状

- `refs/moq` は draft-21 に更新済み（draft-20 は削除）。README・docs・CHANGES には draft-21 への言及がなく、コードの参照は draft-20 のまま。
- draft-20 参照の規模: `src/` 86 ファイル・1707 件、`devtools/` 18 件、`tests/e2e/` 2 件、`README.md` 3 件、`.env.example` 1 件、`docs/LOW_LEVEL_API.md`。
- draft-21 Appendix A.1 は「編集上の変更のみ」と明記し、ワイヤ形式・フィールド順・値域・エラーコード値・パラメータ型は draft-20 と同一。実装ロジックの変更は不要。
- 一方で文書は大規模に再構成され節番号が全面シフトした。代表例: Control Messages §10 → §9、Message Parameters §10.2 → §9.20、MOQT Properties §12 → §10、Error Codes §15.11 → §16.11、Grease §14 → §13、Object Status §11.2.1.1 → §11.1.2、Subgroup Header §11.4.2 → §11.3.1。
- 一部の節は意味論・ワイヤ構造・コード定義に分割された。単純な番号置換では壊れる: §5.1.2 → 意味 §3.3.1 / ワイヤ §9.20.10、§5.1.4 → 意味 §3.3.2 / 構造 §8.6、§3.5 → 意味 §6.6 / コード §12.2、§10.6.2 → 形式 §9.4.2 / コード §12.3、§10.12 → メッセージ §9.9 / コード §12.4、§11.4 → §11.3（Subgroup）/ §11.4（Fetch）、§10.2.2 と §10.3.1.4 → パラメータ §9.20.3 / §9.1.4、構造 §8.9。
- 図表・付録番号も変化した。`src/message/authorizationToken.ts` の `Authorization Token Alias Type` コメントが引く "Figure 5 / Section 15.5" は draft-21 では "Figure 3 / §16.5"、`src/message/fetch.test.ts` の "Figure 16" は "Figure 15"、`src/session.ts` の単方向ストリーム種別表 "Table 3" は "Table 2"。draft-20 の Appendix A.1 を指す参照は draft-21 では A.2。
- 誤引用が 1 件ある。`src/session.ts` の `cancelSubscription` メソッドのコメントは "Section 3.3.1"（draft-20 では 0-RTT）を引くが、内容は Request Cancellation and Rejection であり、正しくは draft-20 §3.3.3 → draft-21 §6.4.2.3。
- 全 128 節の対応表を「付録: 節番号対応表」に示す。

## 設計方針

- `refs/moq/draft-ietf-moq-transport-21.txt` の目次・各節とコメントを照合し、ドラフト名・節番号・節タイトルを直す。
- 対象パス: `src/`（`*.ts` / `*.test.ts` / `*.prop.ts`）、`tests/`、`devtools/`、`docs/`、`README.md`、`.env.example`。除外: `CHANGES.md` の過去エントリ、`issues/`、`refs/`、draft-ietf-moq-msf / draft-ietf-moq-loc など他ドラフトの参照。
- 分割節は付録の「備考」に従い用途別に飛び先を分け、意味論・ワイヤ構造・コード定義を混同しない。
- 図表番号（Figure / Table）・Appendix 番号（A.1 → A.2）も更新する。
- ワイヤ値・ロジック・公開 API は変更しない。実装ギャップは別 issue に委譲する。
- issue 番号参照の削除は 0506、仕様履歴メモの削除は 0464 に委譲し本 issue では扱わない（同一ファイルの編集順序に注意）。
- 0412（`MessageParameterType` ヘッダコメント）と 0435（`subgroupDeliveryTimeout` doc コメント）は編集対象が重なる。closed 済みなら結果を継承し、open なら相互参照して調整する。
- 0508（`docs/LOW_LEVEL_API.md` / examples）と編集対象が重なるため着手順を調整する。
- 完了後に polish-refs で全引用を検証する。
- コメントのみの変更のため、`CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追記する（README / docs の `.md` のみの変更は変更履歴の対象外）。

## 完了条件

- 対象パスで draft-ietf-moq-transport-20 / draft-20（transport 由来）の参照が 0 件（`CHANGES.md` の過去エントリ、`issues/`、`refs/`、他ドラフト参照を除く）。
- 引用する節番号・節タイトルが draft-21 の目次と一致する。分割節は用途別の飛び先に更新されている。
- 図表番号・Appendix 番号（A.1 → A.2）が draft-21 と一致する。
- polish-refs の検証で引用の不一致が報告されない。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` がある。
- `vp check` / `tsc --noEmit` / `vp test run` が通る（コメントのみのためテスト変化なし）。

## 参照

- `refs/moq/draft-ietf-moq-transport-21.txt` 目次 / Appendix A.1 / A.2
- 先例: `issues/closed/0461-draft-20-update-draft-20-section-references.md`
- 関連: `issues/0412-doc-fix-message-parameter-type-header-comment.md`, `issues/0435-update-subgroup-delivery-timeout-options-doc-comment.md`, `issues/0464-doc-remove-obsolete-spec-history-comments.md`, `issues/0506-doc-comment-conventions.md`, `issues/0508-doc-lowlevel-examples.md`

## 付録: 節番号対応表

`src/` が参照する draft-20 の節番号（transport 由来）と draft-21 の対応先。参照回数降順。MSF / LOC / moqmetrics / moqlog 由来の節は対象外。draft-20 §3.1.6（Connection URL）・§11.4.1（Stream Cancellation）・§11.6（Examples）は draft-21 で削除済みだが、`src/` からの参照は 0 件。

| draft-20 節 | draft-20 タイトル                            | draft-21 節                   | draft-21 タイトル                                                  | 参照回数 | 備考                                                                  |
| ----------- | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ | -------: | --------------------------------------------------------------------- |
| §5.1.4      | Range Filters                                | 3.3.2 / 8.6 / 9.20.11-9.20.15 | Range Filters / Range Filter Structure / Range Filter 各パラメータ |      111 | 分割: 意味は §3.3.2 / ワイヤは §8.6 / 各パラメータは §9.20.11-9.20.15 |
| §5.1.2      | Location Filters                             | 3.3.1 / 9.20.10               | Location Filters / LOCATION FILTER Parameter                       |       98 | 分割: 意味は §3.3.1 / ワイヤは §9.20.10                               |
| §11.4.2     | Subgroup Header                              | 11.3.1                        | Subgroup Header                                                    |       94 |                                                                       |
| §10.4       | GOAWAY                                       | 9.2                           | GOAWAY                                                             |       92 |                                                                       |
| §10.9       | REQUEST_UPDATE                               | 9.5                           | REQUEST_UPDATE                                                     |       69 |                                                                       |
| §10.2.18    | FORWARD Parameter                            | 9.20.19                       | FORWARD Parameter                                                  |       62 |                                                                       |
| §10.2.15    | FILL PARAMETERS Parameter                    | 9.20.16                       | FILL PARAMETERS Parameter                                          |       55 |                                                                       |
| §10         | Control Messages                             | 9                             | Control Messages                                                   |       51 |                                                                       |
| §3.3.2      | Graceful Request Stream Closure              | 6.4.2.2                       | Graceful Request Stream Closure                                    |       46 |                                                                       |
| §10.1       | Request ID                                   | 6.4.2.1                       | Request ID                                                         |       42 | Stream Usage へ移動                                                   |
| §10.2.1     | Parameter Scope                              | 9.20.1                        | Parameter Scope                                                    |       39 |                                                                       |
| §10.9.1     | Updating Subscriptions                       | 9.5.1                         | Updating Subscriptions                                             |       39 |                                                                       |
| §2.4.1      | Track Naming                                 | 2.4.1                         | Track Naming                                                       |       38 | エンコードは §8.7                                                     |
| §10.2       | Message Parameters                           | 9.20                          | Control Message Parameters                                         |       38 | Control Message Parameters へ改称                                     |
| §2.4.2      | Malformed Tracks                             | 12.1                          | Malformed Tracks                                                   |       37 | Error Handling へ移動                                                 |
| §3.3.3      | Request Cancellation and Rejection           | 6.4.2.3                       | Request Cancellation and Rejection                                 |       35 |                                                                       |
| §11.4.4.1   | Flags                                        | 11.4.1.1                      | Flags                                                              |       35 |                                                                       |
| §10.3.1.6   | MAX FILTER RANGES                            | 9.1.6                         | MAX FILTER RANGES                                                  |       34 |                                                                       |
| §1.4.3      | Key-Value-Pair Structure                     | 8.3                           | Key-Value-Pair Structure                                           |       33 |                                                                       |
| §5.1.3      | Fill Semantics                               | 3.4                           | Fill Semantics                                                     |       33 |                                                                       |
| §11.3.1     | Object Datagram                              | 11.2.1                        | Object Datagram                                                    |       32 |                                                                       |
| §14         | Grease                                       | 13                            | Grease                                                             |       32 |                                                                       |
| §10.2.2     | AUTHORIZATION TOKEN Parameter                | 9.20.3 / 8.9                  | AUTHORIZATION TOKEN Parameter / Authorization Token Compression    |       31 | 分割: パラメータは §9.20.3 / Token 構造は §8.9                        |
| §3.3        | Session initialization                       | 6.3                           | Session initialization                                             |       30 |                                                                       |
| §10.12      | PUBLISH_DONE                                 | 9.9 / 12.4                    | PUBLISH_DONE / Publish Done Codes                                  |       30 | 分割: メッセージは §9.9 / コードは §12.4                              |
| §10.20      | SUBSCRIBE_TRACKS                             | 9.18                          | SUBSCRIBE_TRACKS                                                   |       30 |                                                                       |
| §3.5        | Termination                                  | 6.6 / 12.2                    | Termination / Session Termination Codes                            |       27 | 分割: 意味は §6.6 / コードは §12.2                                    |
| §10.2.8     | GROUP ORDER Parameter                        | 9.20.9                        | GROUP ORDER Parameter                                              |       27 |                                                                       |
| §10.5       | REQUEST_OK                                   | 9.3                           | REQUEST_OK                                                         |       27 |                                                                       |
| §10.9.2     | Updating Namespace Subscriptions             | 9.5.2                         | Updating Namespace Subscriptions                                   |       26 |                                                                       |
| §10.10      | PUBLISH_STATE_NOTIFY                         | 9.10                          | PUBLISH_STATE_NOTIFY                                               |       26 |                                                                       |
| §10.2.9     | LOCATION FILTER Parameter                    | 9.20.10                       | LOCATION FILTER Parameter                                          |       25 |                                                                       |
| §10.2.21    | INCLUDE_PROPERTIES Parameter                 | 9.20.22                       | INCLUDE_PROPERTIES Parameter                                       |       25 |                                                                       |
| §11.2.1.1   | Object Status                                | 11.1.2                        | Object Status                                                      |       25 |                                                                       |
| §2.5.1      | Mandatory Track Properties                   | 3.6                           | Mandatory Track Properties                                         |       24 |                                                                       |
| §3.2.1      | Reserved Namespaces                          | 2.4.2                         | Reserved Namespaces                                                |       24 | Object Data Model へ移動                                              |
| §10.2.16    | EXPIRES Parameter                            | 9.20.17                       | EXPIRES Parameter                                                  |       24 |                                                                       |
| §10.19      | SUBSCRIBE_NAMESPACE                          | 9.15                          | SUBSCRIBE_NAMESPACE                                                |       24 |                                                                       |
| §12.7       | Immutable Properties                         | 10.7                          | Immutable Properties                                               |       24 |                                                                       |
| §10.11      | PUBLISH                                      | 9.8                           | PUBLISH                                                            |       23 |                                                                       |
| §3.2.2      | Session-Level Tracks and Namespaces          | 6.5                           | Session-Level Tracks and Namespaces                                |       22 |                                                                       |
| §5.1        | Subscriptions                                | 3.1                           | Subscriptions                                                      |       22 |                                                                       |
| §11.3       | Datagrams                                    | 11.2                          | Datagrams                                                          |       22 |                                                                       |
| §11.4.4     | Fetch Header                                 | 11.4.1                        | Fetch Header                                                       |       21 |                                                                       |
| §10.13      | FETCH                                        | 9.11                          | FETCH                                                              |       20 |                                                                       |
| §11.4       | Streams                                      | 11.3 / 11.4                   | Subgroup Streams / Fetch Streams                                   |       19 | 分割: Subgroup は §11.3 / Fetch は §11.4                              |
| §10.2.20    | TRACK_NAMESPACE_PREFIX Parameter             | 9.20.21                       | TRACK_NAMESPACE_PREFIX Parameter                                   |       18 |                                                                       |
| §10.16      | PUBLISH_NAMESPACE                            | 9.14                          | PUBLISH_NAMESPACE                                                  |       18 |                                                                       |
| §11.4.4.2   | End of Range                                 | 11.4.1.2                      | End of Range                                                       |       18 |                                                                       |
| §11.2.1.2   | Object Properties                            | 11.1.3                        | Object Properties                                                  |       17 |                                                                       |
| §5.2        | Fetch State Management                       | 3.2.1                         | Fetch State Management                                             |       16 |                                                                       |
| §10.6       | REQUEST_ERROR                                | 9.4                           | REQUEST_ERROR                                                      |       16 |                                                                       |
| §10.14      | FETCH_OK                                     | 9.12                          | FETCH_OK                                                           |       15 |                                                                       |
| §10.2.19    | NEW GROUP REQUEST Parameter                  | 9.20.20                       | NEW GROUP REQUEST Parameter                                        |       14 |                                                                       |
| §3.3.4      | Stream Reset Error Codes                     | 12.5                          | Stream Reset Error Codes                                           |       13 | Error Handling へ移動。IANA 登録は §16.11.4                           |
| §10.3       | SETUP                                        | 9.1                           | SETUP                                                              |       13 |                                                                       |
| §11.4.3     | Closing Subgroup Streams                     | 11.3.2                        | Closing Subgroup Streams                                           |       13 |                                                                       |
| §12.1       | SUBGROUP_DELIVERY_TIMEOUT                    | 10.1                          | SUBGROUP_DELIVERY_TIMEOUT                                          |       13 |                                                                       |
| §8          | Delivery Timeouts and Data Reliability       | 5.2                           | Delivery Timeouts and Data Reliability                             |       12 |                                                                       |
| §3.1.2      | Fragment Identifiers                         | 6.1.1                         | Fragment Identifiers                                               |       11 |                                                                       |
| §10.8       | SUBSCRIBE_OK                                 | 9.7                           | SUBSCRIBE_OK                                                       |       11 |                                                                       |
| §10.15      | TRACK_STATUS                                 | 9.13                          | TRACK_STATUS                                                       |       11 |                                                                       |
| §12         | MOQT Properties                              | 10                            | MOQT Properties                                                    |       11 |                                                                       |
| §1.4.1      | Variable-Length Integers                     | 8.1                           | Variable-Length Integers                                           |       10 |                                                                       |
| §10.6.1     | Redirect Structure                           | 9.4.1                         | Redirect Structure                                                 |       10 |                                                                       |
| §10.6.2     | REQUEST_ERROR Message Format                 | 9.4.2 / 12.3                  | REQUEST_ERROR Message Format / Request Error Codes                 |       10 | 分割: 形式は §9.4.2 / コードは §12.3                                  |
| §2.2        | Subgroups                                    | 2.2                           | Subgroups                                                          |        9 |                                                                       |
| §4          | Extensibility                                | 1.5                           | Modularity                                                         |        9 | Extensibility から Modularity へ改称                                  |
| §10.2.7     | SUBSCRIBER PRIORITY Parameter                | 9.20.8                        | SUBSCRIBER PRIORITY Parameter                                      |        9 |                                                                       |
| §10.2.12    | PRIORITY FILTER Parameter                    | 9.20.13                       | PRIORITY FILTER Parameter                                          |        9 |                                                                       |
| §10.3.1.4   | AUTHORIZATION TOKEN                          | 9.1.4 / 8.9                   | AUTHORIZATION TOKEN / Authorization Token Compression              |        9 | 分割: Setup Option は §9.1.4 / Token 構造は §8.9                      |
| §12.2       | OBJECT_DELIVERY_TIMEOUT                      | 10.2                          | OBJECT_DELIVERY_TIMEOUT                                            |        9 |                                                                       |
| §6.1        | Subscribing to Namespaces                    | 4.1                           | Subscribing to Namespaces                                          |        8 |                                                                       |
| §10.2.17    | LARGEST OBJECT Parameter                     | 9.20.18                       | LARGEST OBJECT Parameter                                           |        8 |                                                                       |
| §2.3        | Groups                                       | 2.3                           | Groups                                                             |        7 |                                                                       |
| §5.1.3.1    | Opening and Closing Fill Fetch Streams       | 3.4.1                         | Opening and Closing Fill Fetch Streams                             |        7 |                                                                       |
| §10.2.4     | OBJECT_DELIVERY_TIMEOUT Parameter            | 9.20.5                        | OBJECT_DELIVERY_TIMEOUT Parameter                                  |        7 |                                                                       |
| §10.2.6     | RENDEZVOUS TIMEOUT Parameter                 | 9.20.7                        | RENDEZVOUS TIMEOUT Parameter                                       |        7 |                                                                       |
| §10.3.1.7   | MAX_REQUEST_UPDATES                          | 9.1.7                         | MAX_REQUEST_UPDATES                                                |        7 |                                                                       |
| §10.17      | NAMESPACE                                    | 9.16                          | NAMESPACE                                                          |        7 |                                                                       |
| §10.20.1    | Parameters on SUBSCRIBE_TRACKS               | 9.18.1                        | Parameters on SUBSCRIBE_TRACKS                                     |        7 |                                                                       |
| §10.21      | PUBLISH_SKIPPED                              | 9.19                          | PUBLISH_SKIPPED                                                    |        7 |                                                                       |
| §12.6       | DYNAMIC GROUPS                               | 10.6                          | DYNAMIC GROUPS                                                     |        7 |                                                                       |
| §10.2.3     | SUBGROUP_DELIVERY_TIMEOUT Parameter          | 9.20.4                        | SUBGROUP_DELIVERY_TIMEOUT Parameter                                |        6 |                                                                       |
| §10.2.5     | FILL TIMEOUT Parameter                       | 9.20.6                        | FILL TIMEOUT Parameter                                             |        6 |                                                                       |
| §12.4       | DEFAULT PUBLISHER PRIORITY                   | 10.4                          | DEFAULT PUBLISHER PRIORITY                                         |        6 |                                                                       |
| §12.5       | DEFAULT PUBLISHER GROUP ORDER                | 10.5                          | DEFAULT PUBLISHER GROUP ORDER                                      |        6 |                                                                       |
| §12.8       | Prior Group ID Gap                           | 10.8                          | Prior Group ID Gap                                                 |        6 |                                                                       |
| §12.9       | Prior Object ID Gap                          | 10.9                          | Prior Object ID Gap                                                |        6 |                                                                       |
| §13.8       | Implementation Identification Fingerprinting | 15.8                          | Implementation Identification Fingerprinting                       |        6 |                                                                       |
| §1.4.4      | Reason Phrase Structure                      | 8.5                           | Reason Phrase Structure                                            |        5 |                                                                       |
| §3.4        | Unidirectional Stream Types                  | 6.4.1                         | Unidirectional Streams                                             |        5 |                                                                       |
| §10.2.13    | OBJECT PROPERTY FILTER Parameter             | 9.20.14                       | OBJECT PROPERTY FILTER Parameter                                   |        5 |                                                                       |
| §10.3.1.1   | AUTHORITY                                    | 9.1.1                         | AUTHORITY                                                          |        5 |                                                                       |
| §10.3.1.2   | PATH                                         | 9.1.2                         | PATH                                                               |        5 |                                                                       |
| §10.3.1.5   | MOQT IMPLEMENTATION                          | 9.1.5                         | MOQT IMPLEMENTATION                                                |        5 |                                                                       |
| §10.7       | SUBSCRIBE                                    | 9.6                           | SUBSCRIBE                                                          |        5 |                                                                       |
| §10.18      | NAMESPACE_DONE                               | 9.17                          | NAMESPACE_DONE                                                     |        5 |                                                                       |
| §10.2.14    | TRACK PROPERTY FILTER Parameter              | 9.20.15                       | TRACK PROPERTY FILTER Parameter                                    |        4 |                                                                       |
| §11.1       | Track Alias                                  | 3.1.2                         | Track Alias                                                        |        4 |                                                                       |
| §15.8       | Properties                                   | 16.8                          | Properties                                                         |        4 |                                                                       |
| §1.4.2      | Location Structure                           | 8.2                           | Location Structure                                                 |        3 |                                                                       |
| §2.5        | Properties                                   | 8.4                           | Track and Object Properties                                        |        3 | bare 参照のみ                                                         |
| §3.1.1      | MOQT URI Scheme                              | 6.1                           | MOQT URI Scheme                                                    |        3 |                                                                       |
| §3.1.4      | WebTransport                                 | 6.2.1                         | WebTransport                                                       |        3 |                                                                       |
| §6.3        | Filtering SUBSCRIBE_TRACKS                   | 4.3                           | Filtering SUBSCRIBE_TRACKS                                         |        3 |                                                                       |
| §10.3.1.3   | MAX_AUTH_TOKEN_CACHE_SIZE                    | 9.1.3                         | MAX_AUTH_TOKEN_CACHE_SIZE                                          |        3 |                                                                       |
| §11         | Data Streams and Datagrams                   | 11                            | Data Streams and Datagrams                                         |        3 |                                                                       |
| §12.3       | MAX CACHE DURATION                           | 10.3                          | MAX CACHE DURATION                                                 |        3 |                                                                       |
| §15.4       | Setup Options                                | 16.4                          | Setup Options                                                      |        3 |                                                                       |
| §15.11.4    | Stream Reset Error Codes                     | 16.11.4                       | Stream Reset Error Codes                                           |        3 |                                                                       |
| §3.6        | Session Migration                            | 6.6.1                         | Graceful Session Migration                                         |        2 |                                                                       |
| §6.2        | Publishing Namespaces                        | 4.2                           | Publishing Namespaces                                              |        2 |                                                                       |
| §10.3.1     | Setup Options                                | 9.1                           | SETUP                                                              |        2 | 統合: Setup Options を SETUP 直下に昇格                               |
| §11.5.1     | Padding Streams                              | 11.5.1                        | Padding Streams                                                    |        2 |                                                                       |
| §11.5.2     | Padding Datagrams                            | 11.5.2                        | Padding Datagrams                                                  |        2 |                                                                       |
| §15.11      | Error Codes                                  | 16.11                         | Error Codes                                                        |        2 |                                                                       |
| §15.11.1    | Session Termination Error Codes              | 16.11.1                       | Session Termination Error Codes                                    |        2 | 定義本文は §12.2                                                      |
| §1.4        | Notational Conventions                       | 8                             | Notational Conventions and Common Structures                       |        1 |                                                                       |
| §3          | Sessions                                     | 6                             | Sessions                                                           |        1 |                                                                       |
| §3.3.1      | 0-RTT                                        | 6.3.1                         | 0-RTT                                                              |        1 |                                                                       |
| §5          | Publishing and Retrieving Tracks             | 3                             | Publishing and Receiving Tracks                                    |        1 | 改称                                                                  |
| §10.2.10    | SUBGROUP FILTER Parameter                    | 9.20.11                       | SUBGROUP FILTER Parameter                                          |        1 | bare 参照のみ                                                         |
| §10.2.11    | OBJECTID FILTER Parameter                    | 9.20.12                       | OBJECTID FILTER Parameter                                          |        1 | bare 参照のみ                                                         |
| §11.2       | Objects                                      | 11.1                          | Objects                                                            |        1 |                                                                       |
| §15.5       | Authorization Token Alias Type               | 16.5                          | Authorization Token Alias Type                                     |        1 |                                                                       |
| §15.11.2    | REQUEST_ERROR Codes                          | 16.11.2                       | REQUEST_ERROR Codes                                                |        1 | bare 参照のみ。定義本文は §12.3                                       |
| §15.11.3    | PUBLISH_DONE Codes                           | 16.11.3                       | PUBLISH_DONE Codes                                                 |        1 | bare 参照のみ。定義本文は §12.4                                       |
