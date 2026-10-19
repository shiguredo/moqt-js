# 購読側に復号前の再生遅延を追加する

- Created: 2026-10-19
- Completed: 2026-10-19
- Branch: feature/add-pre-decode-delay
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

高レベル API の購読側で、意図的に再生を遅らせる手段を追加する。想定する遅延は 2 秒以上であり、ライブ配信を数秒遅らせて視聴する用途を対象にする。

「受信バッファサイズを変更する仕組み」では実現しない。`ConnectOptions.dataStreamMaxBufferBytes` と `dataStreamMaxTotalBufferBytes` は、未完成の Object を保持してよいバイト数の上限であり、超過時は `EXCESSIVE_LOAD` でストリームを打ち切るメモリ保護の仕組みである。値を大きくしても Object の復号タイミングは変わらず、再生遅延は制御できない。バイト数はビットレートに依存するため、遅延を時間で指定することもできない。

2 秒以上の遅延を復号済みフレームのキューで実現すると、1080p 30 fps で約 60 枚、60 fps で約 120 枚の `VideoFrame` を保持することになり、メモリが現実的でない。`JITTER_BUFFER_MAX_QUEUED_FRAMES` の拡大も同じ問題を抱える。したがって、受信した圧縮済み Object を復号前に時間で保持する仕組みを追加する。

## 現状

- 再生時刻は `src/playout/timeline.ts` の `PlayoutTimeline` が `TIMESTAMP + 基準の遅れ + 再生遅延` として決める。catalog の `targetLatency` は `PlayoutTimeline.setTargetLatencyMs` で再生遅延の下限として使われるが、これは publisher が catalog で宣言する値であり、購読側が任意の遅延を指定する手段は無い。
- `MAX_PLAYOUT_DELAY_MS` (500 ms) は jitter buffer の遅延に対する上限であり、`PlayoutTimeline` の表示の遅れをこれ以上にはしない。2 秒以上の遅延には使えない。
- 復号済み映像の表示待ちは `src/playout/buffer.ts` の `PlayoutBuffer` が保持し、上限は `JITTER_BUFFER_MAX_QUEUED_FRAMES` (24 枚) である。2 秒分のフレームを保持する用途を想定していない。
- `src/createMediaSubscriber.ts` は音声と映像の Object を受信した時点で復号へ渡す。復号前に Object を保持するキューは無い。
- 音声の受信側追いつき (`src/playout/audioReceiveCatchUp.ts`) は「復号の出力の遅れ - 入力の遅れ」を復号器が足している遅れとして判定する。復号前に意図的な遅延を入れると、この値が意図した遅延の分だけ増え、復号器が詰まっていると誤判定する。
- `MediaSubscriberOptions` には遅延を指定するフィールドが無い。`createMediaSubscriber` の接続設定も catalog の `targetLatency` の解決だけを行う。

## 設計方針

### 公開 API

`MediaSubscriberOptions` に `preDecodeDelayMs?: number` を追加する。

- 既定は 0 (追加遅延なし)。
- 0 より大きい有限数。上限は `MAX_PRE_DECODE_DELAY_MS` = 30,000 ms とする。
- 実際の表示遅延は、この値に経路と復号の遅れ、jitter buffer の遅延が加わる。厳密な総遅延の指定ではなく、復号前に加える遅延である。
- catalog の `targetLatency` とは加算される。`targetLatency` が 100 ms なら、2,000 ms を指定したときの表示遅延は約 2,100 ms 以上になる。
- 遅延は生成時に固定する。購読中の動的変更は対象外とする。
- devtools の UI と URL クエリは対象外とする。

### 復号前 Object キュー

- `src/playout/preDecodeDelay.ts` に `PreDecodeDelayQueue<T>` を追加する。ブラウザ API に依存せず、時刻は引数で受ける。
- `push(item, bytes, nowMs)` は `dueAtMs = nowMs + delayMs` で積む。`takeDue(nowMs)` は期限が来た item を積んだ順に返す。`nextDueMs()` / `clear()` / `size` / `bufferedBytes` を持つ。
- 保持上限はトラックごとに `PRE_DECODE_QUEUE_MAX_BYTES` = 64 MiB、`PRE_DECODE_QUEUE_MAX_OBJECTS` = 8,192 件とする。上限を超えたら古い Object から落とし、`onError` を購読期間あたりメディアごとに 1 回だけ通知する。単一 Object がバイト上限を超える場合はその Object を保持しない。
- 音声と映像で別々のキューを持つ。メディアごとに `setTimeout` を 1 本だけ使い、期限が来た item をまとめて処理してから次の期限を設定する。

### 購読処理への配線

- 音声は `receiveAudioObject` で到着時刻を記録し、重複排除のあと `handleAudioObject` へ渡す。`handleAudioObject` は初期 configure の保留判定を行い、保留でなければ遅延キューへ積む。タイマーが期限を迎えたら既存の復号処理を呼ぶ。
- 映像は `receiveVideoObject` → `VideoGroupGate` の順序制御を今までどおり即時に行い、Group の保留を抜けた後の `handleVideoObjects` で遅延キューへ積む。タイマーが期限を迎えたら既存の `handleVideoObject` を呼ぶ。`subgroupEnd` は今までどおり即時に処理する。
- 復号前キューからの取り出し時に閉状態を再確認する。`close()` / `stop()` ではキュー、タイマー、上限超過の通知済みフラグを破棄する。
- 映像デコーダーのエラー時は復号前キューを破棄する。音声の追いつきで復号器を作り直すときは音声の復号前キューを破棄し、古い入力を再投入しない。

### 音声の受信側追いつき

- `AudioReceiveCatchUpObservation` に `intentionalDelayMs?: number` を追加し、`decodeLagMs` の計算から意図した遅延を引く。
- `AudioPlayoutSession` の `AudioPlayoutRequest` に `intentionalDelayMs?: number` を追加し、そのまま観測へ渡す。`createMediaSubscriber` は実際に保持した時間を渡す。0867 で devtools にも動的な遅延を追加したため、devtools は「未指定 (0) のまま」ではなくなった。
- これにより、意図した遅延を復号器の詰まりと誤判定しない。実際に復号器が遅れた場合は従来どおり追いつきが始まる。

### 通信仕様

- ワイヤフォーマット、MOQT のパラメータ、catalog、MSF のフィールドは変更しない。購読側のローカルな再生制御だけを変える。publisher と relay は遅延の存在を知らない。

## 完了条件

- `createMediaSubscriber` に `preDecodeDelayMs: 2000` を渡すと、音声と映像の復号開始と表示が約 2 秒遅れる。`getStats().avSync.presentationDelayMs` が指定値の分だけ増える。
- 2 秒の遅延中に保持されるのは圧縮済み Object だけで、復号済みの `VideoFrame` は保持されない。キューの `bufferedBytes` と件数で確認できる。
- `preDecodeDelayMs` 未指定または 0 のとき、既存の挙動とテストが変わらない。
- 音声と映像の A/V 同期が保たれる。音声の `audio.playoutCatchUp.decodeLagMs` は意図した遅延を含まず、追いつきが誤発動しない。実際の復号の遅れでは従来どおり追いつきが始まる。
- `close()` / `stop()` 後に遅延キューから復号が走らない。
- 負数、`NaN`、`Infinity`、`MAX_PRE_DECODE_DELAY_MS` 超過の指定はエラーになる。
- キュー上限超過時は古い Object が破棄され、`onError` がメディアごとに 1 回通知される。
- `src/playout/preDecodeDelay.test.ts`、`src/createMediaSubscriber.test.ts`、`src/playout/audioReceiveCatchUp.test.ts`、`src/playout/audioPlayoutSession.test.ts` にテストを追加する。モックやスタブは使わない。
- `vp check` / `tsc --noEmit` / `vp test run` / `vp build` が通る。
- `docs/PLAYOUT_DELAY.md` を追加し、`docs/HIGH_LEVEL_API.md`、`docs/AV_SYNC_DECISIONS.md`、`README.md` を更新する。`CHANGES.md` は MOQT RFC ドラフト中のため更新しない。

## 参照

- `src/playout/timeline.ts` の `PlayoutTimeline` / `MAX_PLAYOUT_DELAY_MS` / `targetLatency`
- `src/playout/buffer.ts` の `PlayoutBuffer` / `JITTER_BUFFER_MAX_QUEUED_FRAMES`
- `src/createMediaSubscriber.ts` の `MediaSubscriberImpl` / `handleAudioObject` / `handleVideoObjects` / `receiveAudioObject` / `receiveVideoObject`
- `src/codec/types.ts` の `MediaSubscriberOptions`
- `src/session/publicTypes.ts` の `ConnectOptions.dataStreamMaxBufferBytes` / `dataStreamMaxTotalBufferBytes`
- `src/playout/audioReceiveCatchUp.ts` の `AudioReceiveCatchUp`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession` / `AudioPlayoutRequest`
- `docs/AV_SYNC_DECISIONS.md` の決定 1 / 4 / 10
- `docs/AUDIO_PLAYOUT_LATENCY.md` の音声の再生遅延の実測
- draft-ietf-moq-loc-04 §2.3.1.1 / §2.3.1.2 (TIMESTAMP と Timescale)
- draft-ietf-moq-transport-22 §12.5 (EXCESSIVE_LOAD)

## 解決方法

- `MediaSubscriberOptions.preDecodeDelayMs` と `MAX_PRE_DECODE_DELAY_MS` を追加した。未指定または 0 は追加遅延なしとし、負数・非有限数・上限超過は生成時に拒否する。
- `src/playout/preDecodeDelay.ts` に `PreDecodeDelayQueue` を追加した。期限は積んだ時刻 + 遅延で決まり、件数とバイト数の上限を超えたら古い Object から落とす。単一 Object がバイト上限を超える場合は保持しない。
- `src/createMediaSubscriber.ts` で、音声は `receiveAudioObject` から復号前キューへ、映像は `GroupSwitchGate` を通した後の `handleVideoObjects` から復号前キューへ積む。メディアごとに 1 本のタイマーで期限を待ち、期限後に復号する。`close()` / `stop()` でキューとタイマーを破棄する。
- 音声の入力の遅れは、復号前の遅延を挟んでも到着時点の値で記録する。初期 configure の保留を経由しても失わないよう、保留中の Object にも到着時刻を持たせた。
- `AudioReceiveCatchUpObservation.intentionalDelayMs` と `AudioPlayoutRequest.intentionalDelayMs` を追加し、出力の遅れから入力の遅れと意図した遅延を引いて「復号が足している遅れ」を求めるようにした。音声の追いつきが意図した遅延を復号器の詰まりと誤判定しない。
- 映像デコーダーのエラー時と音声デコーダーのエラー時は復号前の段を破棄する。音声の追いつきで復号器を作り直すときは破棄しない。段が保持しているのは復号器に溜まった古い入力ではなく、これから復号する直近の入力であり、捨てると次の Object が期限を迎えるまで復号へ何も渡らず、指定した遅延の分だけ無音になる。
- `src/playout/preDecodeDelay.test.ts` にキューの境界・順序・上限のテストを追加し、`src/createMediaSubscriber.test.ts` に検証・音声と映像の期限・Group の順序・`close()` の破棄・上限超過の通知のテストを追加した。`src/playout/audioReceiveCatchUp.test.ts` と `src/playout/audioPlayoutSession.test.ts` に意図した遅延のテストを追加した。モックやスタブは使っていない。
- `docs/PLAYOUT_DELAY.md` を追加し、`docs/HIGH_LEVEL_API.md`、`docs/AV_SYNC_DECISIONS.md`、`README.md` を更新した。
- `vp fmt --write .` / `tsc --noEmit` / `vp lint` / `vp test run` (233 ファイル、4099 テスト成功) / `vp run build` が通ることを確認した。

## レビューでの修正 (2026-10-20)

差分レビュー (review-diff-code) の指摘を受けて、次の点を修正した。

- 上限超過で古い Object を落としたとき、残っている Object の期限を「保持できる時間」まで前倒しするようにした。これが無いと、保持できる時間が遅延より短い構成 (高いビットレートで長い遅延) で先頭の期限が来る前に毎回落とされ、復号へ何も渡らなくなる。
- 音声の追いつきで復号器を作り直すときは復号前の段を破棄しない (上の解決方法のとおり)。
- 遅延の保持とタイマーを `src/playout/preDecodeDelayStage.ts` の `PreDecodeDelayStage` へまとめ、音声と映像で重複していた配線を 1 か所にした。上限超過の通知は段が購読期間あたり 1 回に抑える。
- 映像の初期 configure の保留を音声と同じ順序にした。保留キューを経由してから復号前の段へ積むため、`pendingObjectQueue` の上限と通知が効き、遅延の起点も configure 完了後になる。
- `src/playout/preDecodeDelay.prop.ts` (PBT) と `src/playout/preDecodeDelayStage.test.ts` を追加した。`stop()` の破棄、映像側の上限超過通知、復号器のエラー時の段の破棄、実際に保持した時間の記録などのテストも追加した。
- 上限超過で期限を前倒ししたときにタイマーを張り直すようにした。しないと、最初の Object の元の期限 (遅延の分) まで復号が止まり、その間も古い Object を落とし続ける。
- 短縮した遅延は実時間と同じ速さで解消する。音声と映像で短縮量を揃え、A/V 同期が崩れないようにした。
- 音声の追いつきに渡す意図した遅延は、設定値ではなく実際に保持した時間にした。上限超過で短縮した区間でも正しく差し引ける。
- 表示遅延の実測 (`avSync.presentationDelayMs` が指定値の分だけ増えること) は未了である。実リレーでの計測は今後の確認項目とする (docs/PLAYOUT_DELAY.md に記載)。
