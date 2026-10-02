# Fetch semantics の追加に追随する

- Created: 2026-10-02
- Completed: 2026-10-03
- Branch: feature/update-fetch-semantics
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §3.2 は Fetch の意味論を §3.2.1 Fetch Object Delivery / §3.2.2 Gaps in a Fetch Stream / §3.2.3 Relay Fetch Handling / §3.2.4 Fetch State Management に整理した。v21 は §3.2.1 Fetch State Management のみで、§3.2 に Fetch の導入定義・ギャップの意味論・リレー処理が無かった。

本 issue は §3.2.2 / §3.2.3 / §3.2.4 を担当する。次の項目は他の issue の対象であり、本 issue では扱わない。

- §3.2 冒頭の定義 (inclusive の範囲、省略時は {0, 0} と Largest Object) と §1.3 / §3.1 の用語 → 0801
- Largest Object が到着中であり得る前提と「完全に配送する」規定、FETCH_OK の End Location を信頼する方針 → 0804
- Fetch Object に Delivery Mode が適用されないことと用語 → 0799
- FETCH_OK の End Location が inclusive であること (§9.12) → 0805
- LOCATION FILTER のワイヤ形式変更 → 0796

## 対象とする主な規定

- §3.2.2: ギャップは「Object が存在しない」「subscriber のフィルタで除外された」「状態を判定できない (リレーが一時的に Original Publisher と遮断された場合など)」で起こる。Range Filter が無ければ、マークされないギャップは存在しない Object を示し、Range Filter があれば状態不明の Object を示す
- §3.2.2: デフォルトと異なる原因の範囲は End of Range indicator (0x8C / 0x10C / 0x20C、§11.4.1.2) でマークし、non-existent / unknown / timed out の 3 種を示す。unknown の Object を含む FETCH を受けた publisher は、UNKNOWN_OBJECT_STATUS (0x6、§12.5) でデータストリームをリセットするか、End of Unknown Range で示して既知の Object の配送を継続する。relay は §3.2.3 のとおり同じ手段 (§3.2.2 に記述された方法) を使う
- §3.2.2: ストリーム末尾のギャップは FIN でのみ検出可能
- §3.2.3: relay の FETCH 処理 (キャッシュからの先行送信、upstream FETCH、Fill Timeout の総予算) は relay の責務であり、moqt-js (CODEBASE.md のとおりクライアント専用) には関係しない
- §3.2.4: subscriber は FETCH を cancel するか FETCH_ERROR を受信するか、FETCH データストリームが FIN または reset されるまで状態を保持する。キャンセル時は bidi リクエストストリームへの STOP_SENDING が MUST、データストリームへの STOP_SENDING は MAY。文面は v21 §3.2.1 に既にあり、v22 では §3.2.4 へ移動し REQUEST_ERROR が FETCH_ERROR に置き換わっている (呼称は 0802 の対象)

## 現状

実ファイルと照合した結果、次のとおり。

- `src/dataStream/fetch.ts`: End of Range indicator (0x8C / 0x10C / 0x20C) のデコード (`decodeEndOfRange`) とエンコードを実装済み。`FetchSerializationFlags.END_OF_NON_EXISTENT_RANGE` / `END_OF_UNKNOWN_RANGE` / `END_OF_TIMED_OUT_RANGE` と `isEndOfRangeFlags` がある。コメントは v21 §11.4.1.2 を参照している (節番号は v22 でも同じ。ただし表と図の番号は繰り下がっており、v21 Table 7 → v22 Table 8、v21 Table 8 → v22 Table 9、v21 Table 9 → v22 Table 10、v21 Figure 28 → v22 Figure 29 になる。draft バージョン表記と合わせて番号も更新対象)
- `src/session/stream.ts` の `processFetchObjects`: End of Range レコードをアプリへ渡さずスキップし、コンテキスト (Group ID / Object ID / Publisher Priority) のみ更新する。コメントは v21 §11.4.1.2 を参照
- `src/fetcher.ts` の `cancel`: `onCancel` 経由で bidi リクエストストリームの cancel (STOP_SENDING 相当) を送る。データストリームへの STOP_SENDING は行わない (MAY のため必須ではない)。コメントは v21 §3.2.1 (Fetch State Management) を参照しており、v22 では §3.2.4
- `src/session/requests.ts`: キャンセルの結線 (`impl.onCancel` → `requestsCancelFetch`) と `requestsCancelFetch` が v21 §3.2.1 を参照している。`requestsCancelFetch` は `bidiCancelFetch` へ委譲するだけで、実装の重複は無い
- `src/session/bidi.ts` の `bidiCancelFetch`: bidi リクエストストリームの reader.cancel (STOP_SENDING 相当) を送る。データストリームへの STOP_SENDING は行わない。コメントは v21 §3.2.1 を参照
- `src/session/dataStreamIncoming.ts`: FETCH データストリームの終了・打ち切り経路が v21 §3.2.1 を参照している
  - `dataStreamHandlePeerFetchStreamReset`: FIN / reset での状態破棄。「receives REQUEST_ERROR」の引用は v22 では FETCH_ERROR
  - `dataStreamAbortFetchOnBufferOverflow`: バッファ上限での打ち切り。cancel に当たるため `fetcher.cancel()` で bidi リクエストストリームへ STOP_SENDING を送り MUST を満たす
  - `dataStreamHandleMalformedFetchTrack`: §3.2.1 の MUST 引用
  - `dataStreamHandleIncomingStreamError`: reset 時の状態破棄
  - `waitForFetcher` タイムアウト時のストリーム reset
- テストコメントの参照も v21 §3.2.1 のまま: `src/fetcher.test.ts` / `src/session.test.ts` / `src/session/bidiFetchRequestStreamMessages.test.ts` / `src/session/bidiKeyValueFormattingError.test.ts`
- moqt-js の FETCH は `buildFetchParameters` が Range Filters (0x25–0x28) を載せられる。ただし未マークのギャップ (non-existent / unknown) の解釈を行うコードは無く、End of Range レコードをデコードしてスキップするだけ
- End of Range indicator 自体は v21 §11.4.1.2 から存在する。v22 で新設なのは §3.2.2 の「ギャップとは何か」「未マークのギャップの意味」の記述であり、ワイヤ形式は変わらない

## 設計方針

- §3.2.2 について: End of Range をデコードしてスキップする現状が、v22 §3.2.2 の「デフォルトと異なる原因の範囲を End of Range indicator でマークする」と適合することを確認し、`src/session/stream.ts` と `src/dataStream/fetch.ts` のコメントにギャップの意味論 (3 種、Range Filter の有無による未マーク範囲の解釈、FIN でのみ検出可能) と v22 §3.2.2 / §11.4.1.2 の参照を残す。アプリへの通知は仕様上の要件ではないため行わない。通知の要件が生じた場合は別 issue とする
- §3.2.3 について: relay のみの規定であり、moqt-js はクライアント専用 (CODEBASE.md) のため対応しない。取りこぼし確認の結果として out of scope であることを issue に記録する (コード変更は不要)
- §3.2.4 について: `FetcherImpl.cancel` (src/fetcher.ts) / `requestsCancelFetch` と `impl.onCancel` の結線 (src/session/requests.ts) / `bidiCancelFetch` (src/session/bidi.ts) / `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow` / `dataStreamHandleMalformedFetchTrack` / `dataStreamHandleIncomingStreamError` / `waitForFetcher` のタイムアウト経路 (src/session/dataStreamIncoming.ts) と上記テストコメントの参照を v22 §3.2.4 に更新し、MUST (bidi リクエストストリームへの STOP_SENDING) と MAY (データストリームへの STOP_SENDING) の対応を明記する。引用中の REQUEST_ERROR は v22 では FETCH_ERROR (呼称は 0802 の対象)。データストリームへの STOP_SENDING は実装せず、対応する場合は既存のキャンセル経路 (`onCancel`) に載せる
- §11.4.1 / §11.4.1.1 / §11.4.1.2 への参照は節番号こそ v22 でも同じだが、表と図の番号が繰り下がっているため、draft バージョン表記と合わせて Table 8 / 9 / 10 と Figure 29 に直す。あわせて v21 §11.4.1.2 にあった SHOULD NOT (Object を分割する目的以外で End of Non-Existent Range を使わない) が v22 §3.2.2 へ移っていることを §3.2.2 のコメントに含める
- 挙動変更は伴わないため、テストの追加・変更は行わない

## 完了条件

- §3.2.2 / §3.2.3 / §3.2.4 と実装の対応が確認され、コメントが v22 を参照している (§3.2.4 への更新、§3.2.2 の根拠追加)
- アプリへのギャップ通知とデータストリームへの STOP_SENDING を行わない判断 (仕様上の MUST ではない) がコメントに記録されている
- §3.2.3 が out of scope である旨が issue に記録されている
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §3.2.2 (Gaps in a Fetch Stream) / §3.2.3 (Relay Fetch Handling) / §3.2.4 (Fetch State Management) / §11.4.1.2 (End of Range) / §12.5 (UNKNOWN_OBJECT_STATUS)
- `src/dataStream/fetch.ts` の `decodeEndOfRange` / `isEndOfRangeFlags` / `FetchSerializationFlags`
- `src/session/stream.ts` の `processFetchObjects`
- `src/fetcher.ts` の `cancel` / `FetcherImpl`
- `src/session/requests.ts` の `requestsCancelFetch` / `impl.onCancel` の結線
- `src/session/bidi.ts` の `bidiCancelFetch`
- `src/session/dataStreamIncoming.ts` の `dataStreamHandlePeerFetchStreamReset` / `dataStreamAbortFetchOnBufferOverflow` / `dataStreamHandleMalformedFetchTrack` / `dataStreamHandleIncomingStreamError`
- `src/session/params.ts` の `buildFetchParameters` (Range Filters の搭載確認)
- `src/fetcher.test.ts` / `src/session.test.ts` / `src/session/bidiFetchRequestStreamMessages.test.ts` / `src/session/bidiKeyValueFormattingError.test.ts`

## 解決方法

### 1. §3.2.4 (Fetch State Management) への参照更新 (完了条件 a)

v21 §3.2.1 が v22 §3.2.4 へ移動したため、`src/fetcher.ts` / `src/session/requests.ts` / `src/session/bidi.ts` / `src/session/dataStreamIncoming.ts` とテスト (`fetcher.test.ts` / `session.test.ts` / `bidiCancelMalformedTrackPeers.test.ts` / `bidiFetchRequestStreamMessages.test.ts` / `bidiKeyValueFormattingError.test.ts`) と `bidi.prop.ts` の参照を更新した。MUST (bidi リクエストストリームへの STOP_SENDING) と MAY (データストリームへの STOP_SENDING) の対応も明記した。

- `FetcherImpl.cancel` は bidi リクエストストリームへ STOP_SENDING を送る (MUST を満たす)。データストリームへは送らない (MAY)
- データストリームを打ち切る経路 (malformed track の検出、バッファ上限) は `cancelStreamQuiet` で既にデータストリームを打ち切っており、重ねて送らない
- state の保持条件 (cancel / FETCH_ERROR の受信 / FIN / reset まで) を引用している箇所は、v22 の文面に合わせて引用を FETCH_ERROR に直した (コード上の呼称の更新は 0802 の対象)

### 2. §3.2.2 (Gaps in a Fetch Stream) の根拠追加 (完了条件 a)

`src/session/stream.ts` と `src/dataStream/fetch.ts` のコメントに、ギャップの意味論を残した。

- ギャップは「Object が存在しない」「subscriber のフィルタで除外された」「状態を判定できない (リレーが一時的に Original Publisher と遮断された場合など)」で起こる
- Range Filter を送っていなければマークされていないギャップは存在しない Object を、送っていれば状態が不明な Object を示す
- デフォルトと異なる原因の範囲は End of Range indicator (0x8C / 0x10C / 0x20C、§11.4.1.2) でマークされ、non-existent / unknown / timed out の 3 種を示す。unknown を含む FETCH を受けた publisher は UNKNOWN_OBJECT_STATUS (0x6、§12.5) で reset するか End of Unknown Range で続行する
- publisher は Object を分割する目的以外で End of Non-Existent Range を使うべきではない (§3.2.2 の SHOULD NOT。v21 では §11.4.1.2 にあった)
- ストリーム末尾のギャップは FIN でのみ検出できる
- アプリへのギャップの通知は仕様が求めていないため行わない (通知の要件が生じたら別 issue とする)

### 3. §3.2.3 (Relay Fetch Handling) は out of scope (完了条件 c)

relay の FETCH 処理 (キャッシュからの先行送信、upstream FETCH、Fill Timeout の総予算) は relay のみの規定であり、CODEBASE.md のとおりクライアント専用の moqt-js には関係しない。受信した FETCH は `src/session/incoming.ts` で unsupported request (NOT_SUPPORTED) として扱う。コード変更は行わない。

### 4. 表と図の番号の訂正 (issue の前提の修正)

issue には「§11.4.1.2 への参照は節番号・内容とも v22 で不変」とあったが、実際には v22 で表と図の番号が繰り下がっていた (v21 Table 7 → v22 Table 8 (End of Range)、Table 8 → 9 (Subgroup ID)、Table 9 → 10 (Additional flags)、Figure 28 → 29 (Fetch Object Fields))。版表記だけを更新すると誤引用になるため、`src/dataStream/fetch.ts` / `src/fetcher.ts` / `src/dataStream.fetch.test.ts` / `src/dataStream/common.ts` / `src/session/incoming.prop.ts` の表・図番号も v22 に合わせた。あわせて、v22 で言い回しが変わった逐語引用 (§11.4.1 の Serialization Flags の説明、Group ID Delta の "(default)" など) と、節の表題 (v22 §11.4.1 は "Fetch Header"、§11.4.1.1 は "Flags") を直した。§3.2 へ移った引用 (FETCH_OK より先にデータストリームが到着し得ること、FETCH_ERROR の呼称) も参照先を付け替えた。なお "Forwarding Preference" を含む引用は v22 で用語が Delivery Mode に変わっているため、その 2 箇所だけ版表記を v21 のまま残し、改名は 0799 の担当とした。

### 5. 検証

`vp check` / `tsc --noEmit` / `vp test run` (198 files / 3569 tests) が通る。`/review-diff-code` を 3 周回し、2 周目までの指摘 (表・図番号の更新漏れ、逐語引用の不一致、CHANGES.md の位置) はすべて反映した。CHANGES.md に [UPDATE] エントリを追加した (挙動は変えず、コメントのみの変更)。

なお `src/publisher.test.ts` と `src/publisher.prop.ts` の見出しが `draft-ietf-moq-transport-21 Section 3.2.1` (Fetch State Management) を参照しているが、Publisher のテストに fetch の節は無関係であり、本 issue の対象外とした (誤参照の候補。`src/publisher.ts` は Section 3 を参照している)。
