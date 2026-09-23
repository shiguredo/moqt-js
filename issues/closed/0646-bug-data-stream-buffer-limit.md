# 受信データストリームのバッファに上限が無い

- Created: 2026-09-21
- Completed: 2026-09-24
- Branch: feature/fix-data-stream-buffer-limit
- Polished: 2026-09-21

## 目的

確立後のデータストリーム受信はチャンクを受け取るたびにバッファを伸ばすが、上限が無い。悪意ある、あるいは壊れたピアが 1 本のストリームで無制限にメモリを消費させられる。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleIncomingStream` は受信のたびに `buffer.length + value.length` の新しい配列を作り、ヘッダーまたは Object が揃うまで保持する。`dataStreamHandleSubgroupStream` の subscriber mode と `dataStreamHandleFillFetchStream` も同じ形で伸ばす。バッファ長を検査する箇所は確立後のどの経路にも無い
- 宣言された payload Length は「揃ったかどうか」の判定にしか使わない。payload が足りない間は `src/session/stream.ts` の `processSubgroupObjects` / `processFetchObjects` が `totalNeeded > buffer.length` で打ち切って残バッファを保持する (`IncompleteDataError` は fields / header の不足時のもの)。巨大な Length を宣言したまま実データを送り続ければ Object が完成しないため、バッファは伸び続ける
- `DATA_STREAM_TIMEOUT` の期限は `dataStreamCreateDataStreamTimeout` の `arm` がチャンク到着ごとに張り直すため、送り続けるピアには発火しない。fill fetch の経路はそもそもタイマーを張らない
- `src/pendingSubgroupBuffer.ts` には per-stream (1 MiB) / per-session (16 MiB) のバイト上限と timeout があるが、これは Track Alias 未確立の間だけの経路であり、確立後の受信経路には上限が無い

## 設計方針

- ストリーム単位の受信バッファ上限を新設し、チャンクを追記した直後に検査して、超過したら当該データストリームを打ち切る。上限は「完成前の Object の payload 全長」を受けられる値にする
- 既定値は 32 MiB とし、`ConnectOptions.dataStreamMaxBufferBytes` で変更できるようにする (内部フィールド `session.dataStreamMaxBufferBytes` として `dataStreamTimeoutMs` と同じ経路で流し、`docs/LOW_LEVEL_API.md` の表にも載せる)。32 MiB の根拠は、媒体フレームが通常 1 MiB 未満であることと、issues/0659 が測定に使う 16 MiB Object を余裕で受けること。`pendingSubgroupBuffer` の 1 MiB は Track Alias 未確立の並べ替え窓用で用途が違うため流用しない
- 本 issue はストリーム単位の上限だけを対象とする。per-session の合計上限は対象外とする (必要になったら別途)
- 打ち切りは `cancelStreamQuiet` で受信方向を打ち切り、セッションは閉じない。`cancelStreamQuiet` の引数は文字列 reason で wire のエラーコードは送れないため、既存の malformed 打ち切りと同じ書式で reason に `code=${DataStreamErrorCode.EXCESSIVE_LOAD}` を含める (`DataStreamErrorCode.EXCESSIVE_LOAD` は 0x9 で定義済み。draft-ietf-moq-transport-21 §12.5)。テストの期待値はこの書式に合わせる
- 打ち切りは正常完了として通知しない。ピア RESET_STREAM でストリームが終了したときと同じ形に揃え、FETCH はアプリへ error を通知して fetcher を closed にし、`fetchers` から削除、`clearPriorGapTrackingIfUnused`、`onRequestDrained` まで行う。fill は `fillFetchTargets` から削除して `handleFillError` でアプリに失敗を伝える (購読は継続する)。subgroup subscriber mode は該当 Track の購読へ error を通知して closed にする。正常終了の `handleEnd` は呼ばない
- アプリへ渡す error には `DataStreamErrorCode.EXCESSIVE_LOAD` を載せる。ピア RESET_STREAM 経路が `streamErrorCode` を載せているのと同じ形にし、アプリが理由を判別できるようにする
- 上限超過を検出した時点で、その場で打ち切りの後始末を行って return する。バッファを破棄したうえでループの後続処理に落とさず、ループ後の「未完成 Object の FIN」判定 (PROTOCOL_VIOLATION) や正常終了の後始末 (FETCH の `fetcher.handleEnd`、fill の FIN 相当の処理) には到達させない
- `src/session.test.ts` の DATA_STREAM_TIMEOUT のテスト群の隣に、上限超過で打ち切られセッションが閉じないことと、上限以下が従来どおり受信できることを固定するテストを追加する

## 完了条件

- 上限を超えた受信データストリームが打ち切られ、セッションは閉じない。打ち切りの reason に `DataStreamErrorCode.EXCESSIVE_LOAD` を埋め込んだ `code=9` が含まれる
- 打ち切り時に経路ごとの後始末 (FETCH の error 通知・`fetchers` からの削除・`clearPriorGapTrackingIfUnused`・`onRequestDrained`、fill の失敗通知と `fillFetchTargets` からの削除、subgroup subscriber mode の購読 error 通知と closed 化) が実行され、正常完了 (`handleEnd`) は通知されない
- アプリへ渡る error から `DataStreamErrorCode.EXCESSIVE_LOAD` を判別できる
- 既定値 (32 MiB) 以下の正常な受信が従来どおり動く
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §12.5 (Stream Reset Error Codes。EXCESSIVE_LOAD 0x9 は endpoint が過負荷でストリームを reset する場合)
- draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT 0x12)
- draft-ietf-moq-transport-21 §11.3.1 (Track Alias 未確立ストリームを brief period だけ buffer してよい)

## 解決方法

- `ConnectOptions.dataStreamMaxBufferBytes` (既定 32 MiB = 33,554,432 バイト、0 以下で上限なし) を追加し、`connectionApplyTimeoutOptions` 経由で `session.dataStreamMaxBufferBytes` に流した。`docs/LOW_LEVEL_API.md` の `ConnectOptions` 表にも載せた
- `src/session/dataStreamIncoming.ts` の受信ループ 3 経路で、チャンクを追記した直後 (初回はヘッダー解析後の残バッファ) に上限を判定し、超えていれば `cancelStreamQuiet` で打ち切って return する。残バッファは破棄し、FIN 時の未完成 Object 判定 (PROTOCOL_VIOLATION) や正常終了の後始末 (handleEnd) へは到達させない。セッションは閉じない
  - FETCH: `dataStreamAbortFetchOnBufferOverflow` が打ち切りと後始末を行う。アプリへ error を通知してから `fetcher.cancel()` を呼ぶ。draft-ietf-moq-transport-21 §3.2.1 は、データストリームが開いている間に購読側から FETCH を取り消す場合に bidi リクエストストリームへ STOP_SENDING を送ることを MUST としており、`cancel()` がそれを行う (markClosed を先に呼ぶと state が closed になり cancel が no-op になって MUST を満たせない)。`cancel()` が `fetchers` / `requestStreams` の削除、Prior ID Gap 追跡の掃除、`onRequestDrained` まで行う
  - fill fetch: `dataStreamAbortFillOnBufferOverflow` が `fillFetchTargets` から削除し、`handleFillError` でアプリへ失敗を伝える。§3.4.1 により購読は継続する (終了通知は出さない)
  - Subgroup subscriber mode: `bidi.bidiCancelSubscriptionWithError` で該当 Track Alias に登録された購読を失敗させる (error 通知 + closed 化 + bidi リクエストストリームの cancel + Map の掃除 + `onRequestDrained`)。`bidiCancelSubscription` が同期区間で `subscribersByAlias` の配列を splice するため、走査前に複製して取りこぼしを防ぐ (`cancelMalformedTrackPeers` と同じ)
- アプリへ渡す error には `streamErrorCode` に `EXCESSIVE_LOAD` (0x9) を載せ、メッセージにもコード名と値を含める。打ち切りの reason 文字列にも既存の malformed 打ち切りと同じ書式で `code=${DataStreamErrorCode.EXCESSIVE_LOAD}` を含める (`cancelStreamQuiet` は文字列 reason しか渡せず wire のコードを送れないため)
- 上限判定は `>` 比較であり、上限ちょうどは打ち切らない

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2566 tests) が通る
- テストは、3 経路の上限超過 (打ち切り・後始末・アプリ通知・セッション非閉塞・正常終了の不通知)、上限以下・上限ちょうど・上限 0 の正常受信、同一 Track Alias の複数購読の取りこぼし防止、fill の追記直後検査、reason の `code=9`、`initialize` 経由のオプション反映、既定値 32 MiB を追加した
- 変異テストで、上限比較の `>=` 化 / 打ち切り条件の削除 / reason のコード削除 / `streamErrorCode` の削除 / Subgroup の購読 cancel の削除 / `slice()` の削除 / fill の追記直後検査の削除 / 打ち切りを break にして FIN 判定へ落とす / initialize の配線削除、のいずれでも対応するテストが失敗することを確認した (レビュアーは独立に 26 種を実施)

## 残した課題

- per-session の合計上限は対象外 (多数のストリームを同時に開かれれば合計は上限 × 本数まで増える。`pendingSubgroupBuffer` には per-session 16 MiB がある)
- Track Alias 未確立 (pending mode) は `pendingSubgroupBuffer` の既存上限 (per-stream 1 MiB / per-session 16 MiB) に委ねる
- 追記後に判定するため厳密なメモリ上限ではなく、ピークは上限 + 1 チャンクになる
- `cancelStreamQuiet` の reason は wire のエラーコードを送れないため、§12.5 の「reset / STOP_SENDING には relevant なコードを使う SHOULD」は wire 上では満たせない (既存の malformed 打ち切りと同じ制約)
- `connect()` 経由の end-to-end 配線テストは無い (WebTransport の実体が必要。`initialize` 経由で固定)
- `dataStreamTimeoutMs` の `connect()` 配線と `initialize` のインライン型の重複 (ConnectionInitializeOptions) は差分外の既存事項
- 高レベル API (`createMediaSubscriber` など) からは `dataStreamMaxBufferBytes` を指定できない (既存オプションと同じ)
