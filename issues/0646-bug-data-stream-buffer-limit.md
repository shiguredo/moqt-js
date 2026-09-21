# 受信データストリームのバッファに上限が無い

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
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

{未着手}
