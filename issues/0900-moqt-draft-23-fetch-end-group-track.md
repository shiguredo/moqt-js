# FETCH の End of Group と End of Track indicator を処理する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-end-group-track
- Polished: 2026-11-03

## 目的

draft 23 §3.2.2 / §11.4.2.2 は FETCH に End of Group (0x80) と End of Track (0x81) を追加した。FETCH_OK の End Of Track 削除後は、FETCH データから終端を認識する必要がある。

## 現状

- `src/dataStream/fetch.ts` の `decodeFetchObjectFields` は従来の End of Range 以外の 128 以上を拒否する
- `src/session/stream.ts` の `processFetchObjects` は実 Object と範囲 indicator しか扱わない
- `src/fetcher.ts` の `endOfTrack` は FETCH_OK の旧フィールドでのみ設定される

## 設計方針

- 0x80 / 0x81 を追加フィールドの無い indicator として扱う。直前の Object を Group / Track の終端として記録し、0x81 は Group の終了も意味する
- 次の ID 復元に使う prior Object ID を 2^64-1 にする。最後の実 Object の Group / Object ID を別に保持し、算術用文脈から推測せず、その実 Object の位置を終端情報へ記録する。End of Range や終端 indicator を挟んでも実 Object の位置を保持する
- 前提となる実 Object をまだ受信していない 0x80 / 0x81 は、存在しない prior Object への参照として MALFORMED_OBJECT にする。実 Object を受信済みなら、End of Range 直後や終端 indicator の連続という理由だけで拒否せず、保持した実 Object の位置を参照する。Object → End of Group → End of Track では同じ位置を Group / Track の終端に使い、既知の状態と矛盾する宣言は 0901 の判定へ接続する
- indicator をペイロード空の実 Object としてアプリへ配送したり、Object / Byte 統計を増やしたりしない
- 0x81 の受理時に Fetcher.endOfTrack を true にし、通常の FETCH FIN では変更しない。onEnd はデータストリームの終了を通知する既存の役割を保つ。0897 で応答受理時に確定した endLocation は範囲上限なので書き換えない
- 実 Object の終端位置を Track の最終位置追跡へ反映し、同じ Track の後続購読 / FETCH に対する malformed 検証にも使う。0901 の Object 状態判定と追跡を共有し、End of Range の範囲端や算術用の 2^64-1 を実 Object の終端として登録しない

## 完了条件

- 0x80 / 0x81 が 1 フィールドで消費され、後続 Group を正しく decode できる
- indicator がチャンク末尾にある場合と FIN が別チャンクの場合を検証する
- End of Track の通知時点と、単なる FETCH FIN の違いを公開 API で説明できる
- indicator の統計・Object callback への漏れが無い
- 実 Object 不在時の拒否・エラー分類と、実 Object の後に End of Range / 終端 indicator を挟んでも実終端位置が保持されることを検証する。Object → End of Group → End of Track で同じ位置を再利用できる

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.2.2 / §11.4.1 / §11.4.2.2 / §12.1
- `src/dataStream/fetch.ts`、`src/session/stream.ts`、`src/fetcher.ts`、`src/session/endOfGroupTracking.ts`

## 解決方法

{未着手}
