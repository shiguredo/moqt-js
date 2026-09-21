# 受信データストリームのバッファに上限が無い

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-data-stream-buffer-limit
- Polished: {YYYY-MM-DD}

## 目的

確立後のデータストリーム受信はチャンクを受け取るたびにバッファを伸ばすが、上限が無い。悪意ある、あるいは壊れたピアが 1 本のストリームで無制限にメモリを消費させられる。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleIncomingStream` は受信のたびに `buffer.length + value.length` の新しい配列を作り、ヘッダーまたは Object が揃うまで保持する。`dataStreamHandleSubgroupStream` の subscriber mode と `dataStreamHandleFillFetchStream` も同じ形で伸ばす
- 宣言された payload Length は「揃ったかどうか」の判定にしか使わない (不足なら `IncompleteDataError` で次のチャンクを待つ)。巨大な Length を宣言したまま実データを送り続ければ Object が完成しないため、バッファは伸び続ける
- `DATA_STREAM_TIMEOUT` の期限は `dataStreamCreateDataStreamTimeout` の `arm` がチャンク到着ごとに張り直すため、送り続けるピアには発火しない
- `src/pendingSubgroupBuffer.ts` には per-stream / per-session のバイト上限と timeout があるが、これは Track Alias 未確立の間だけの経路であり、確立後の受信経路には上限が無い

## 設計方針

- ストリーム単位の受信バッファ上限を新設する定数で設け、超過したら当該データストリームを打ち切る。既存の `dataStreamHandleMalformedFetchTrack` と同じく `cancelStreamQuiet` で受信方向を打ち切り、セッションは閉じない
- 打ち切りの理由には draft-ietf-moq-transport-21 §12.5 の `EXCESSIVE_LOAD` (0x9) を使う
- 上限値は `dataStreamTimeoutMs` と同じくテストから短縮できるようにする
- 上限超過でストリームが打ち切られ、セッションが閉じないことをテストで固定する

## 完了条件

- 上限を超えた受信データストリームが閉じ、セッションは閉じない
- 上限以下の正常な受信が従来どおり動く
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §12.5 (Stream Reset Error Codes。EXCESSIVE_LOAD 0x9 は endpoint が過負荷でストリームを reset する場合)
- draft-ietf-moq-transport-21 §12.2 (DATA_STREAM_TIMEOUT 0x12)
- draft-ietf-moq-transport-21 §11.3.1 (Track Alias 未確立ストリームを brief period だけ buffer してよい)

## 解決方法

{未着手}
