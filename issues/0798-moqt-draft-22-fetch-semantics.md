# Fetch semantics の追加に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-fetch-semantics
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 は §3.2 に Fetch の意味論を新設した (§3.2.1 Fetch Object Delivery / §3.2.2 Gaps in a Fetch Stream / §3.2.3 Relay Fetch Handling / §3.2.4 Fetch State Management)。v21 は §3.2.1 Fetch State Management のみで、範囲の既定・ギャップ・End of Range・リレー処理が明確でなかった。moqt-js の実装とコメントを新しい記述に合わせ、規定の取りこぼしがないか確認する。

主な規定:

- FETCH は Start Location から End Location までを inclusive に要求し、省略時は {0, 0} と Largest Object が既定 (§3.2)
- Largest Object が到着中でも、範囲に含む FETCH はその Object を完全に配送する (§3.2)
- ギャップは「存在しない」「不明」「タイムアウト」の 3 種で、End of Range indicator (0x8C / 0x10C / 0x20C) で示す (§3.2.2、§11.4.1.2)。リレーは UNKNOWN_OBJECT_STATUS でリセットすることもできる (§3.2.2)
- Fetch Object には Object の Delivery Mode は適用されない (§3.2.1)
- キャンセルは bidi リクエストストリームへの STOP_SENDING が MUST、データストリームへの STOP_SENDING は MAY (§3.2.4)

## 現状

- `src/dataStream/fetch.ts` は End of Range (0x8C / 0x10C / 0x20C) のデコード・エンコードを実装済み。`decodeEndOfRange` と `isEndOfRangeFlags` がある
- `src/session/stream.ts` の `processFetchObjects` は End of Range レコードをアプリへ渡さずスキップし、コンテキスト (Group ID / Object ID / Priority) のみ更新する
- `src/fetcher.ts` の `cancel` は `onCancel` 経由で bidi リクエストストリームの STOP_SENDING 相当を送る。データストリームへの STOP_SENDING は行わない (v22 では MAY のため必須ではない)
- `src/session/params.ts` の `resolveFetchStartLocation` は開始位置の省略・相対・Next Object を Largest Object 依存として undefined にし、絶対指定のみ確定する。終了側を Largest Object にクランプする処理は無い
- コメントは v21 §3.2.1 / §11.4.1.2 を参照している

## 設計方針

- §3.2 の各規定と実装の対応を確認し、コメントを v22 の節番号・文言に更新する (特に「終了省略時は Largest Object」「Largest Object が到着中でも完全に配送」「Fetch には Delivery Mode が適用されない」)
- ギャップの 3 種をデコードのみでアプリに通知しない現状は仕様上問題ないことをコメントに残す。通知が必要という要件が出た場合は別 issue とする
- 終了側の Largest Object クランプは publisher / relay の責務であり、クライアントの `Fetcher` は FETCH_OK の End Location を信頼する現状のままでよいことを確認してコメントに書く
- データストリームへの STOP_SENDING (MAY) は現状対応しない。対応する場合も既存のキャンセル経路 (`onCancel`) に載せる
- 既存テスト (End of Range のデコード / スキップ、Descending の Group ID 復号、キャンセル) を維持する

## 完了条件

- §3.2 の各規定と実装の対応が確認され、コメントが v22 を参照している
- 挙動変更を伴う場合はテストが追加されている (現状の見込みではコメント更新のみ)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.2-§3.2.4 / §11.4.1.2 (End of Range)
- `src/dataStream/fetch.ts` の `decodeFetchObjectFields` / `decodeEndOfRange` / `FetchSerializationFlags`
- `src/session/stream.ts` の `processFetchObjects`
- `src/fetcher.ts` の `cancel` / `FetcherImpl`
- `src/session/params.ts` の `resolveFetchStartLocation` / `validateFetchOkEndLocation`

## 解決方法

{未着手}
