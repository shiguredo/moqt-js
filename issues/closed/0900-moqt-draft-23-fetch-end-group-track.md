# FETCH の End of Group と End of Track indicator を処理する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
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

- `src/dataStream/fetch.ts` に `END_OF_GROUP` (0x80) / `END_OF_TRACK` (0x81) を追加し、追加フィールドを持たない indicator (Serialization Flags のみ) として復号するようにした。判定と種別変換は `FETCH_STREAM_END_KINDS` の 1 つの表から導く。
- 終端位置は算術用の prior Object ID からではなく `FetchObjectContext.lastActualObject` (最後の実 Object の位置) から取る。End of Range indicator や連続する終端 indicator を挟んでも参照先は最後の実 Object のままで、`DecodedFetchObject.streamEnd` として種別と位置を返す。受理後は §11.4.2.2 に従い prior Object ID を 2^64-1 にする (prior Group ID は直前までの復号値を維持する)。
- 前提となる実 Object を受信していない 0x80 / 0x81 は、存在しない prior Object への参照として送信前に拒否する (§12.2 の MALFORMED_OBJECT に対応。分類移行までは PROTOCOL_VIOLATION として扱う旨をコメントに明記)。
- `src/session/stream.ts` の `processFetchObjects` は indicator を配送も統計計上もせず、Track 単位の追跡へ終端を記録する。0x81 のみ `FetchObjectSink.handleEndOfTrack` を呼び、`FetcherImpl.handleEndOfTrack` が `Fetcher.endOfTrack` を true にする。単なる FIN では変更せず、`endLocation` も書き換えない。fill fetch の sink は通知先の Fetcher が無いため no-op とし、追跡だけを行う。
- `src/session/priorGapTracking.ts` の per-Track 追跡に Group 終端 (上限 1024、最古破棄) と Track 終端 (1 件) を追加し、`recordFetchObjectEnd` (記録) と `assertNoObjectAfterFetchEnd` (§12.1 条件 4 / 5 の検証) を実装した。End of Range の範囲端や算術用の 2^64-1 は終端として登録しない。FETCH / Subgroup / datagram の 3 経路で検証し、判定は受信状態への登録より前に行う。
- `encodeFetchObjectFields` も Flags のみを書く対称実装にした。
- `docs/LOW_LEVEL_API.md` の `Fetcher.endOfTrack` 表・`fetch()` の流れ・`processFetchObjects()` 節を、End of Track indicator の受理で true になること、indicator を配送・統計計上しないことを含めて更新した。
- テストは 0x80 / 0x81 の固定ワイヤ (1 フィールド消費、後続 Group の Object 復号、encode 対称性、不完全 varint)、EOR を挟んだ終端位置の保持、Group 変更 EOR 後の EOG、実 Object 不在の拒否、2^64-1 加算の overflow、processFetchObjects の配送・統計除外、チャンク末尾と分割 feed、0x81 の sink 通知と endOfTrack、後続 FETCH / Subgroup / datagram の条件 4 / 5 検証、拒否 Object の非登録、上限破棄を検証する。PBT では EOR 0〜3 件を挟んだ終端位置の不変と Object → End of Group → End of Track の位置再利用を検証する。

### 既知の制限

- 既知の終端と矛盾する End of Group / End of Track 宣言の検出は未実装であり、`recordFetchObjectEnd` は受理した宣言で上書きする (Track 単位の状態判定として別途対応)。
- 実 Object 不在の終端 indicator は、draft-23 の MALFORMED_OBJECT ではなく現行の PROTOCOL_VIOLATION で閉じる (分類移行は別途対応)。
- §12.1 の final Object の定義は Object Status / Subgroup FIN を指し、FETCH の indicator は列挙されていない。§11.4.2.2 の prior Object を同じ最終 Object として適用する解釈である。
- End of Range で Group が変わった後の End of Group の prior Group ID は、§11.4.2.2 が Object ID だけを定めるため EOR の復号値を維持する (固定ワイヤで固定)。
- fill fetch には Track 終端を通知する公開 API が無い (購読は PUBLISH_DONE 前提)。
- 統合ブランチのため ALPN は moqt-22 のままで、実リレー E2E は移行完了後に確認する。

### 残課題 (別 issue で扱う)

- 非存在と受信済み Object の矛盾検出 (0901)
- セッションエラー分類の移行 (0902)
