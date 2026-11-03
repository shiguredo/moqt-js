# MOQT draft 23 の適合確認を完了してプロトコル識別子と仕様参照を切り替える

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-moqt-draft-23
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 → 23 と、同時に取得した関連 draft 6 件の全文差分を現行実装と照合した。以下の移行を終えてから接続時のプロトコル識別子を moqt-23 にし、公開する対応範囲・参照を実装と一致させる。参照ファイルを新版に置き換えただけでは対応済みとしない。

## 現状

- 調査時点のコードは `ff5d0294`。`src/connect.ts` の `connect` は `protocols: ["moqt-22"]` を提示する
- `README.md`、`CODEBASE.md`、API 文書、ソースコメント・テストには draft 22 および旧 companion draft の記述がある
- 今回の変更は `refs/moq/` の資料更新と issue 起票であり、実装・プロトコル識別子の切替は未実施である

## 起票した移行項目

| issue | 目的                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0894  | [制御メッセージ長を varint にし MAX_CONTROL_MESSAGE_SIZE を交渉する](0894-moqt-draft-23-control-message-framing.md)              |
| 0895  | [FILL_PARAMETERS の外側 Length を除き Parameter count で区切る](0895-moqt-draft-23-fill-parameters-count.md)                     |
| 0896  | [FORWARD を PAUSED に置き換えて値の意味を反転する](0896-moqt-draft-23-paused-parameter.md)                                       |
| 0897  | [FETCH_OK を REQUEST_OK に統合し終端を要求範囲と LARGEST_OBJECT から求める](0897-moqt-draft-23-fetch-request-ok.md)              |
| 0898  | [FETCH の同一 Group 内 Object ID Delta に 2 を加える](0898-moqt-draft-23-fetch-object-id-delta.md)                               |
| 0899  | [FETCH の End of Range を delta 符号化し Gone を受理する](0899-moqt-draft-23-fetch-range-indicators.md)                          |
| 0900  | [FETCH の End of Group と End of Track indicator を処理する](0900-moqt-draft-23-fetch-end-group-track.md)                        |
| 0901  | [非存在と受信済み Object の矛盾を Track 全体で検出する](0901-moqt-draft-23-object-state-consistency.md)                          |
| 0902  | [セッション終了コードを draft 23 の具体的なエラー分類に移行する](0902-moqt-draft-23-specific-session-errors.md)                  |
| 0903  | [REQUEST_ERROR の末尾を Error Details にし REDIRECT と UNSUPPORTED_PROPERTY を扱う](0903-moqt-draft-23-request-error-details.md) |
| 0904  | [NAMESPACE に Parameters を追加し同一 namespace の更新を通知する](0904-moqt-draft-23-namespace-parameters.md)                    |
| 0905  | [SUBSCRIBE_TRACKS_ID で受信 PUBLISH を要求に正確に関連付ける](0905-moqt-draft-23-subscribe-tracks-id.md)                         |
| 0906  | [重なる namespace prefix への更新を許可し NAMESPACE_DONE の暗黙適用を処理する](0906-moqt-draft-23-namespace-prefix-updates.md)   |
| 0907  | [SUBSCRIBE_TRACKS の初期パラメータを draft 23 の明示一覧に揃える](0907-moqt-draft-23-subscribe-tracks-parameters.md)             |
| 0908  | [PUBLISH の FILL_PARAMETERS を受理して初期 fill fetch に関連付ける](0908-moqt-draft-23-publish-fill-semantics.md)                |
| 0909  | [EXPIRES を TRACK_STATUS_OK を含むすべての OK で受理する](0909-moqt-draft-23-expires-all-ok.md)                                  |
| 0910  | [受信 PUBLISH の要求受信者に届いた GOAWAY を拒否する](0910-moqt-draft-23-goaway-request-direction.md)                            |
| 0911  | [通常の Track Name を非空にし namespace Redirect の空値と区別する](0911-moqt-draft-23-nonempty-track-names.md)                   |
| 0912  | [Mandatory Track Property の判定から GREASE 値を除外する](0912-moqt-draft-23-grease-mandatory-properties.md)                     |
| 0913  | [対応済み Property の Track / Object scope 違反を malformed とする](0913-moqt-draft-23-property-scope-validation.md)             |
| 0914  | [対応済み Property の重複を既定で拒否し未知型の反復を保つ](0914-moqt-draft-23-property-duplicate-validation.md)                  |
| 0915  | [REQUEST_ERROR と PUBLISH_DONE と reset の登録コードを同期する](0915-moqt-draft-23-request-done-reset-codes.md)                  |
| 0916  | [LOC 05 の CODEC_STRING Property を読み書きする](0916-loc-draft-05-codec-string.md)                                              |
| 0917  | [C4M 02 の moqt claim を map にし SETUP と SUBSCRIBE_TRACKS を反映する](0917-c4m-draft-02-claim-map-actions.md)                  |
| 0918  | [C4M claim label の旧ベクタ固定値を最新の暫定値運用へ移す](0918-c4m-draft-02-provisional-claim-labels.md)                        |
| 0919  | [C4M 02 の ckt と jkt に confirmation の解釈を揃える](0919-c4m-draft-02-confirmation-claims.md)                                  |
| 0920  | [C4M の一次テストベクタを 02 の COSE バイナリ形式へ更新する](0920-c4m-draft-02-test-vectors.md)                                  |
| 0921  | [ログとメトリクスの namespace を 3 field にし Track Name を ASCII 数字にする](0921-moqt-draft-23-observability-track-names.md)   |
| 0922  | [ログを秒単位 Group とバイナリ Log Record へ移行する](0922-moqt-draft-23-log-binary-records.md)                                  |
| 0923  | [メトリクスの versioned catalog と Metric Description を追加する](0923-moqt-draft-23-metrics-versioned-catalog.md)               |
| 0924  | [メトリクスの Capture Info と値を catalog 参照のバイナリ形式にする](0924-moqt-draft-23-metrics-binary-values.md)                 |

## transport 22 → 23 の差分照合

本文の差分と Appendix A.1 の全 35 項目を照合した。改ページ・折り返し、表・図・参照の採番、日付、参考文献の版更新だけの差分は実装変更から分けた。

| 差分                                                 | 対応                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FILL_PARAMETERS の count 化                          | 0895                                                                                                                                                                      |
| 制御 Length の vi64 化、MAX_CONTROL_MESSAGE_SIZE     | 0894                                                                                                                                                                      |
| FETCH_OK の REQUEST_OK 化と旧終端フィールド削除      | 0897、0900                                                                                                                                                                |
| FETCH の相対 Location Filter を INVALID_RANGE にする | 0897 の送信前検証                                                                                                                                                         |
| FORWARD → PAUSED、ID と値の反転                      | 0896                                                                                                                                                                      |
| REQUEST_UPDATE の処理・応答順を固定                  | `bidiProcessRequestStreamMessages` / `incomingPublishRunStreamSubLoop` が逐次 await、`resolvePendingRequestUpdate` が対象要求の先行更新を選ぶ。既存動作を移行テストで維持 |
| fill を含む REQUEST_UPDATE の coalesce 禁止          | 現行の受信処理は coalesce せず個別応答する。新形式でもこの性質を維持                                                                                                      |
| relay の LARGEST_OBJECT の計算と上流購読条件         | relay 専用。クライアント実装へ上流購読・キャッシュ集約を追加しない                                                                                                        |
| namespace の overlap 許可、SUBSCRIBE_TRACKS_ID       | 0905、0906                                                                                                                                                                |
| namespace prefix 更新の効果                          | 0906                                                                                                                                                                      |
| SUBSCRIBE_TRACKS の明示的な許可一覧                  | 0907                                                                                                                                                                      |
| 同じ prefix の複数 PUBLISH_NAMESPACE                 | `namespacesPublishNamespace` は新しい Request ID ごとに `namespacePublications` に登録し、prefix の重複拒否を持たない。個々の取消しも Request ID 単位                     |
| NAMESPACE の Parameters と更新再通知                 | 0904                                                                                                                                                                      |
| SUBSCRIBE_TRACKS / PUBLISH の初期 fill               | 0907、0908                                                                                                                                                                |
| 全 OK の EXPIRES                                     | 0897、0909                                                                                                                                                                |
| 具体的な Session エラー分類                          | 0902                                                                                                                                                                      |
| REQUEST_ERROR の Error Details / REDIRECT            | 0903                                                                                                                                                                      |
| UNSUPPORTED_PROPERTY Detail                          | 0903                                                                                                                                                                      |
| TRACK_STATUS_OK の未知 Mandatory Track Property      | `bidiReadTrackStatusResponse` が decode 失敗を reject し、FIN と同じ Track の取消しを行う。relay の downstream 応答は対象外。GREASE の例外は 0912                         |
| EXPIRED_AUTH_TOKEN PUBLISH_DONE                      | 0915                                                                                                                                                                      |
| UNAVAILABLE REQUEST_ERROR                            | 0915。relay の stream credit 管理は対象外                                                                                                                                 |
| request stream GOAWAY の送信方向                     | 0910                                                                                                                                                                      |
| Request ID を再利用しない、全重複の検出義務を緩和    | `nextRequestId` は 2 ずつ進む。既存のパリティ・検出済み重複の拒否は維持し、検出を弱める変更は不要                                                                         |
| Track Name の非空                                    | 0911                                                                                                                                                                      |
| DYNAMIC_GROUPS を知らない間の NEW_GROUP_REQUEST 許可 | 初期 SUBSCRIBE は既に事前広告なしで送信できる。公開 Subscriber の update は Track Properties 受信後に使うため、現行 API のためだけに未確立更新を追加しない                |
| Gone 状態、End of Gone Range                         | 0899、0901                                                                                                                                                                |
| FETCH End of Range の delta 化                       | 0899                                                                                                                                                                      |
| FETCH Object ID Delta の +2                          | 0898                                                                                                                                                                      |
| FETCH の End of Group / End of Track                 | 0900                                                                                                                                                                      |
| UNKNOWN_OBJECT_STATUS reset の削除                   | 0915。Unknown は Range として扱い、通常 FIN と混同しない                                                                                                                  |
| 既知 Property の scope 違反                          | 0913                                                                                                                                                                      |
| 既知 Property の既定の重複禁止と未知型の反復         | 0914                                                                                                                                                                      |
| 後続 Object に備えた Subgroup PROPERTIES bit         | `publishSendObjectInternal` は `SubgroupHeaderType.FIRST_OBJ_EXT` で常に Properties を許可しており、既存動作で充足                                                        |
| GREASE を Mandatory Track Property から除外          | 0912                                                                                                                                                                      |
| timeout の対象とトレードオフの説明                   | §15.6 は実装の設定判断の説明。固定の新 MUST や新しい全機能を要求していない。既存 control / data timeout と公開設定の説明へ必要な内容を反映する                            |

Appendix A.1 以外にも、本文では prefix を含む REQUEST_UPDATE の coalesce 禁止、fill の None 表現・PUBLISH Request ID の明確化、Property の scope / 反復、旧 .session の空 Track Name 特例の削除、エラーコードの優先順位などを確認した。prefix 更新は現状 1 件ずつ送っており coalesce しない。それ以外は上表の対応 issue に含める。

## 関連 draft 6 件の差分照合

| 更新                         | 差分と判断                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOC 04 → 05                  | CODEC_STRING (0x11、Track / Object) 追加。0916。transport 参照の更新は本 issue                                                                                                                                                                                                                                                                                          |
| C4M 01 → 02                  | moqt の map、未知 key の fail-closed、SETUP 統合と SUBSCRIBE_TRACKS 追加は 0917。未割当 label / 新 Private Use ベクタは 0918。ckt / jkt と旧 key 3 は 0919。CBOR・完全 COSE バイナリ・暗号・scope・validation ベクタ全体は 0920                                                                                                                                         |
| C4M 01 → 02 の replay / DPoP | catreplay=1 の connection 単位制約は relay の認可処理。新 DPoP は JWT から COSE_Sign1 / CWT、整数 actx、ath、ckt に変更されたが、現行には proof 作成・送受信機能が無い。既存 cnf の更新だけを 0919 で扱い、未割当 actx / ath や proof の transport binding を推測で実装しない。対応済みとも説明しない                                                                   |
| timestamp 00 → 01            | CLOCK_ID の 0〜63 予約、TAI=1、POSIX は省略で表す、CLOCK_ID 無しの TIMESTAMP_ORIGIN の許可、Track Properties の関連付け時点、TEMPO 参照と例を確認。現行はこの拡張の Property ID を解釈・生成しておらず、LOC TIMESTAMP と別物なので新規機能を追加する issue は作らない                                                                                                   |
| Privacy Pass auth 03 → 04    | SETUP 呼称、SUBSCRIBE_TRACKS、prefix 認可、Error Details の challenge、USE_VALUE / single-use / migration、失効 status と error 登録、reverse flow の説明を確認。現行は opaque token / 外部 resolver の入口であり、Privacy Pass の発行・検証・replay を実装していない。§3.4 が transport binding 未確定と明記するため番号を新設しない。汎用 Error Details の受信は 0903 |
| moq-log 03 → 04              | 3 field / ASCII 名は 0921、秒 Group / binary Log Record / Attributes / gap・終了・推奨 Properties・発見・FETCH / fill・MSF 利用は 0922                                                                                                                                                                                                                                  |
| moq-metrics 02 → 03          | 3 field / ASCII 名は 0921、versioned catalog / Metric Description は 0923、Capture Info / binary values / full 64 bit Group / sparse metrics・終了・filter・MSF 利用は 0924                                                                                                                                                                                             |

MSF-01 自体は今回更新されておらず、§§9 / 10 と normative references は旧 log-03 / metrics-02 を指している。最新の companion 形式を採用する方針と MSF-01 本文の旧形式との差を、README と該当 helper の説明に明記する。両者が同じワイヤ形式だとは書かない。

## 設計方針

- transport の必須変更 0894〜0915 を終えてから `src/connect.ts` を moqt-23 に切り替える。新しいワイヤを旧識別子で送らない
- companion の対応範囲は 0916〜0924 の実装状況と一致させる。未実装の任意拡張まで一括で対応済みとしない
- README、CODEBASE、API 文書とソース・テストの参照を新版の根拠へ更新する。§9.12 以降、§9.20 → §9.19、§7.4 以降、§16.11 → §16.12 などは本文の意味とともに確認する
- 既存 0669 / 0670 の一般的な誤記・API 文書修正、0865 の catalog fill 変更、0891 の高レベル GOAWAY 通知を重複実装しない。移行に直接必要な前提は相互参照して更新する
- 0823 の空 Track Name を許す旧方針は採用せず、0911 を優先する。0824 の正常・異常入力も同じ方針にする
- CHANGES.md は `CODEBASE.md` の MOQT RFC ドラフト中の特別ルールに従い変更しない
- 型・純粋 codec・Session の実ストリームを使うテストを先に更新し、モックやスタブで新ワイヤを検証したことにしない

## 完了条件

- transport 必須変更を満たし、接続時に moqt-23 を提示する
- ソース・公開型・README / API 文書が同じ対応版と制限を説明する
- 上表の既存対応と対象外の判断を再確認し、実装で前提が変わった項目を放置しない
- `vp check` / `vp run typecheck` / `vp test run` / `vp run build` / `vp run build:devtools` が通る
- draft 23 対応の実リレーで接続・namespace・購読・PUBLISH・FETCH / fill の E2E を確認する。peer が旧版のままなら、相互接続未検証と明記し、単体成功を実リレー成功として扱わない
- 実リレー用の既存 0703 / 0817 / 0892 と役割分担し、relay 側の実装を本リポジトリへ持ち込まない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` 本文全体 / Appendix A.1
- `refs/moq/draft-ietf-moq-loc-05.txt`
- `refs/moq/draft-ietf-moq-c4m-02.txt`
- `refs/moq/draft-frindell-moq-timestamp-01.txt`
- `refs/moq/draft-ietf-moq-privacy-pass-auth-04.txt`
- `refs/moq/draft-jennings-moq-log-04.txt`
- `refs/moq/draft-jennings-moq-metrics-03.txt`
- `src/connect.ts`、`src/session/bidi.ts`、`src/session/incomingPublish.ts`、`src/session/namespaces.ts`、`src/session/publish.ts`
- `README.md`、`CODEBASE.md`、`docs/LOW_LEVEL_API.md`、`docs/HIGH_LEVEL_API.md`

## 解決方法

{未着手}
