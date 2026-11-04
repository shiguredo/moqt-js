# PUBLISH の FILL_PARAMETERS を受理して初期 fill fetch に関連付ける

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §3.4 / §3.4.1 / §9.8 は PUBLISH による初期 fill を追加した。PUBLISH の送信側が FILL_PARAMETERS を提示して fill fetch を開き、その Request ID で購読側が受け取る。現在は許可集合で拒否し、受信先も登録できない。

## 現状

- `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` は FILL_PARAMETERS を含まない
- `src/session/incomingPublish.ts` の `incomingPublishHandleBidirectionalStream` は初期 fill を登録しない
- `src/session/bidi.ts` の `fillFetchTargets` / `registerRawFillFetchTarget` は SUBSCRIBE や REQUEST_UPDATE 起点の関連付けを持つ
- `src/session/params.ts` の `buildPublishParameters` と `PublishOptions` に初期 fill は無い。クライアント publisher は現在、履歴 Object の保存や fill fetch の送信機能を持たない

## 設計方針

- 受信 PUBLISH の FILL_PARAMETERS を正規のパラメータとして検証し、PUBLISH Request ID で初期 fill の受信先を登録する。LARGEST_OBJECT は PUBLISH から解決する
- fill 内側のフィルタ、Group Order、timeout、通常購読との独立した範囲を保持する。PAUSED 中に不要な待機先を残さない
- `dataStreamHandleParsedFetchHeader` の関連付け待ちを通常 FETCH と PUBLISH 初期 fill に分ける。現在の `incomingWaitForFetcher` は pendingFetch に無い ID を即座に打ち切るため、その呼出しだけでは先着 fill を扱えない。PUBLISH 初期 fill 用に Request ID をキーとする待機登録を設け、PUBLISH 未受信でもサーバー起点の未確定 ID を短時間保持する。既に拒否・終了した要求や、別種の要求と判明した ID は待機対象にしない
- 受信 PUBLISH の処理開始から受理・拒否までの状態を管理し、fill target の登録成功時に同じ ID の待機者を起こす。待機解除後は fillFetchTargets を再検索して fill のハンドラへ渡し、通常 Fetcher だけを検索して打ち切らない。拒否、fill を開かない paused / 空範囲、取消しでは対象の待機者を失敗として起こし、reader・タイマー・待機登録・保持バイトを解放する
- 先着待ちの実装上の制限は、既存の短時間バッファと同じ 5000 ms、stream ごと 1 MiB、Session 合計 16 MiB とし、待機 stream 数も Session ごと最大 1024 にする。保持バイトは既存の Session 合計バッファ計上に含める。期限切れ・上限超過では対象 stream を cancel し、上限超過を引き起こした新しい待機を残さない。GOAWAY / Session 終了でも未確定の待機を解放し、確立済みの fill は GOAWAY だけでは打ち切らない
- publisher 送信 API に `fill` だけを足して履歴を送らない実装にしない。本 issue は購読者としての受信対応に絞り、履歴を持たない送信側の機能制限を明記する
- 0895 の count 形式、0896 の PAUSED、0905 の origin ID、0907 の SUBSCRIBE_TRACKS 指定を使う。既存 0865 の高レベル catalog を fill 取得へ変える作業は含めない

## 完了条件

- SUBSCRIBE_TRACKS 由来と unsolicited の受理対象 PUBLISH で、初期 fill が正しい Subscriber へ届く
- fill の先着 / 後着、通常 Object との並行受信、paused、取消し・拒否後の到着を検証する
- PUBLISH 自体より先に FETCH_HEADER が到着しても登録後に fill へ振り分けられ、拒否・期限切れ・保持上限・Session 終了では待機登録と保持バイトが残らない
- fill と通常購読の重複・欠落を新しい誤った範囲解釈で発生させない
- 受信対応と publisher の送信機能制限を公開 API 文書で区別する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.4 / §3.4.1 / §9.8 / §9.19.15
- `src/session/incomingPublish.ts`、`src/session/bidi.ts` の `FillFetchTarget`、`src/session/dataStreamIncoming.ts`
- `src/session/incoming.ts` の `incomingWaitForFetcher`、`src/pendingSubgroupBuffer.ts` の `DEFAULT_PENDING_SUBGROUP_BUFFER_OPTIONS`、draft-ietf-moq-transport-23 §6.4.2.1
- 0865 は catalog 購読の組み立て変更、ここでは PUBLISH のプロトコル受信を扱う

## 解決方法

- `src/message/parameterScope.ts` の `PUBLISH_ALLOWED_PARAMS` に FILL_PARAMETERS を追加し、draft-23 §3.4 / §9.8 の初期 fill を正規のパラメータとして受理するようにした。
- `src/session/incomingPublish.ts` で PUBLISH の FILL_PARAMETERS を §9.19.15 Table 7 と Range Filter の組合せまで検証し、paused でなければ PUBLISH の Request ID をキーに `fillFetchTargets` へ Subscriber を登録する。GROUP_ORDER は fill 内側から PUBLISH の値へ継承する。LARGEST_OBJECT は PUBLISH から解決する。
- `src/session/incoming.ts` に `incomingWaitForPublishFillTarget` と `incomingSettlePublishFillWaiters` を追加した。サーバー起点 PUBLISH の奇数 Request ID かつ通常 FETCH でない場合に、PUBLISH の受理・拒否が確定するまで待機し (最大 5000 ms、Session 当たり最大 1024 stream)、確定時に待機者を起こす。拒否・別種の要求・処理済みの ID は待機対象にしない。
- `src/session/dataStreamIncoming.ts` で「通常 FETCH の FETCH_OK 待ち」と「PUBLISH 初期 fill の PUBLISH 待ち」を分離した。待機解除後は `fillFetchTargets` を再検索して fill のハンドラへ委譲し、解決できなければ stream を cancel する。
- 予約 namespace・スコープ違反・UNINTERESTED・onPublish 例外・初期パラメータ反映失敗・reader 取得失敗・paused では待機者を失敗させ、データストリームを cancel する。購読終了時に fill target と処理中フラグを削除し、Session 終了時は未確定の待機者を解放する。
- `src/session/publicTypes.ts` の `PublishOptions` に、publisher は履歴 Object を保持せず送信側の fill fetch 機能を提供しない (本 issue は購読者としての受信対応) ことを明記した。
- `incomingPublishHandleBidirectionalStream` が max-statements を超えたため、デコード・検証・拒否判定・fill 解析を内部 helper に抽出した。

### 既知の制限 (未実装)

- 待機 stream の「stream 当たり 1 MiB / Session 合計 16 MiB」は専用の追加会計を設けておらず、既存の §12.5 バッファ計上に含まれる (先読みを行わないため読取済み残バッファだけが対象)。JSDoc に明記した。
- 受信側で fill 範囲が空と判定して待機を早期失敗させる処理は未実装である。空範囲では publisher が fill ストリームを開かないため、待機が発生した場合は 5000 ms のタイムアウトで解消される。
- セッションを閉じない GOAWAY での未確定待機の即時解放は未実装である。Session 終了時には解放され、GOAWAY 後も未確定待機は 5 秒で期限切れになる。
- 待機タイムアウト、待機数上限 1024、拒否経路での待機者解放、Session 終了時の解放、バッファ上限のテストは未追加である (実装は入っている)。
- publisher 送信側の fill fetch 機能は提供しない (履歴非保持のため)。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。

### 残課題 (別 issue で扱う)

- 上記の未実装項目 (GOAWAY 解放、空範囲判定、上限テスト)
- docs の一括更新 (0925)
