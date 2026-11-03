# FETCH の End of Group と End of Track indicator を処理する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-end-group-track
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §3.2.2 / §11.4.2.2 は FETCH に End of Group (0x80) と End of Track (0x81) を追加した。FETCH_OK の End Of Track 削除後は、FETCH データから終端を認識する必要がある。

## 現状

- `src/dataStream/fetch.ts` の `decodeFetchObjectFields` は従来の End of Range 以外の 128 以上を拒否する
- `src/session/stream.ts` の `processFetchObjects` は実 Object と範囲 indicator しか扱わない
- `src/fetcher.ts` の `endOfTrack` は FETCH_OK の旧フィールドでのみ設定される

## 設計方針

- 0x80 / 0x81 を追加フィールドの無い indicator として扱う。直前の Object を Group / Track の終端として記録し、0x81 は Group の終了も意味する
- 次の ID 復元に使う prior Object ID を 2^64-1 にする。直前の実 Object の終端位置を失わないよう、算術用文脈と終端情報を分ける
- indicator をペイロード空の実 Object としてアプリへ配送したり、Object / Byte 統計を増やしたりしない
- Fetcher の終端情報と Track の最終位置追跡へ反映し、同じ Track の後続購読 / FETCH に対する malformed 検証にも使う
- 0897 の FETCH 応答移行と 0901 の Object 状態判定に接続する。無い前提 Object の扱いは §11.4 の文脈規則を確認して決める

## 完了条件

- 0x80 / 0x81 が 1 フィールドで消費され、後続 Group を正しく decode できる
- indicator がチャンク末尾にある場合と FIN が別チャンクの場合を検証する
- End of Track の通知時点と、単なる FETCH FIN の違いを公開 API で説明できる
- indicator の統計・Object callback への漏れが無い

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.2.2 / §11.4.1 / §11.4.2.2 / §12.1
- `src/dataStream/fetch.ts`、`src/session/stream.ts`、`src/fetcher.ts`、`src/session/endOfGroupTracking.ts`

## 解決方法

{未着手}
