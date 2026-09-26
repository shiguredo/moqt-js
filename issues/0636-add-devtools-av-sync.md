# devtools の音声と映像を同期して再生する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-av-sync
- Polished: 2026-09-26

## 目的

devtools は相互運用を実測する道具であり、音声と映像がずれて再生されると「配信が正しいか」を目で判定できない。現状は映像と音声がそれぞれ別の時間軸で再生されるため A/V 同期が成立しない。

MSF は `renderGroup` が同じ track を「同時に描画するよう設計されている」と定め (draft-ietf-moq-msf-01 §5.2.11)、`targetLatency` を「符号化から表示までの wallclock の差」と定義する (§5.2.8)。LOC の Timestamp は Timescale が無ければ Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。ライブラリ側は 0635 でこの 2 つを使った同期を実装済みであり、devtools の購読側も同じ計算に乗せる。

## 現状

- `devtools/src/hooks/useSubscriber.ts` は `moqt-js` の `createMediaSubscriber` を使わず、`connect` / `subscribe` と `DecoderWrapper` / `AudioDecoderWrapper` で受信している
- 映像は `PlayoutBuffer` (`src/playoutBuffer.ts`。0762 で `src/` へ移した) が表示時刻を決め、`drawFrame` から `CanvasRenderingContext2D.drawImage` で描く。ただし時間軸 (`PlaybackTimeline`) へ記録しているのは映像だけで、音声は記録していない。表示時刻から `MAX_PRESENTATION_LAG_MS` = 20 ms を超えて遅れたフレームは `PlayoutBuffer` が捨てる
- 音声は `AudioPlayoutScheduler` (`src/audioPlayout.ts`) で並べるが、`schedule` に `targetStartSeconds: null` / `enforceTarget: false` を渡しており、到着基準 (`AUDIO_PLAYOUT_DELAY_SECONDS` = 80 ms の遅れ) で再生する。`AudioClockBridge` は使っていない
- カタログの `targetLatency` / `renderGroup` は `devtools/src/hooks/useSubscriber.ts` で読まれていない (`getTracksByRenderGroup` も使っていない)
- `window.moqtDevTools` の統計に同期ずれの指標が無い

## 設計方針

- 表示時刻を `LOC Timestamp + 基準の遅れ + max(targetLatency, 再生遅延)` として求める (0635 と同じ式)。「基準の遅れ」はトラックごとの「復号の出力の壁時計の時刻 - TIMESTAMP」の直近 10 秒の最小値で、送信側と受信側の時計のずれを含む。上限 (`MAX_PLAYOUT_DELAY_MS` とキューの長さの小さい方) は `max(targetLatency, 再生遅延)` の側にだけ掛ける
- devtools の publisher (`devtools/src/hooks/usePublisher.ts`) は `createMediaPublisher` を使わずに自前で送るが、映像は `src/mediaClock.ts` の `WallClockMapper` で読んだフレームとの対応から、音声は `LOC.toUnixEpochMicroseconds` で、どちらも wall-clock の Timestamp を送るため、購読側だけで同期が成立する
- 音声と映像で同じ時間軸を共有する。`src/playbackTimeline.ts` の `PlaybackTimeline` を devtools の購読側に 1 つ持ち、音声と映像の両方を `observe` する。映像は `PlayoutBuffer` に渡している時間軸をそのまま使い、音声は `AudioClockBridge` で `AudioContext.currentTime` の秒へ換算した目標の開始時刻を `AudioPlayoutScheduler.schedule` に渡す。音声だけを購読しているときは目標を守らない (`enforceTarget: false` で取り直して連続を優先する。0635 と同じ)
- 同期ずれの実績 (`recordPresentation`) を記録する。第 3 引数は「実際に鳴らす / 描く時刻」を Unix epoch マイクロ秒の `bigint` で渡す必要があるため、`AudioClockBridge.toPerformanceMs` が返す `performance.now()` の軸のミリ秒は `performance.timeOrigin` を足してマイクロ秒へ換算する (0635 と同じ)。記録するのは、音声は `schedule` が返した `startAt` を換算した時刻 (捨てた音は記録しない)、映像は `drawFrame` が実際に描いた時刻のうち表示時刻を決められたフレームだけ (表示時刻が `null` のフレームは記録しない。`skewMs` はこの実績から求めるため、記録しないと null のままになる)
- `targetLatency` の解決規則は 0635 の実装と同じにする。ただし解決規則は今 `src/createMediaSubscriber.ts` の中 (module private な `effectiveTargetLatencyMs` と private メソッド `resolveSharedTargetLatencyMs`) にあり、`PlaybackTimeline` は「確定した値だけを受け取る」設計のため、そのままでは devtools から使えない。規則を `CatalogTrack` を取る純関数として `src/msf/tracks.ts` (`getTracksByRenderGroup` と同じ場所) へ切り出し、`createMediaSubscriber` と devtools の両方がそれを使う (規則を 2 か所に書かない)
- 切り出した純関数の規則は 0635 と同じにする。`isLive` が false のトラックの値は無視する (§5.2.8 の MUST)。片方にだけあるときはその値を使う。両方にあって異なるときは、同じ `renderGroup` または `altGroup` なら §5.2.8 の MUST 違反として通知 (通知先は呼び出し側。ライブラリは `onError`、devtools は警告ログ) して大きい方を使い、group が無いか異なれば通知しない。どちらにも無いときは `targetLatency` を使わず、揺らぎから求めた再生の遅れだけを使う (0635 と同じフォールバック)
- `targetLatency` は `PlaybackTimeline` へ `setTargetLatencyMs` で渡し、時間軸を作り直すたびにも渡す (jitter buffer の有効・無効でキューの上限が変わるため、`PlaybackTimeline` と `PlayoutBuffer` は今も作り直している)
- `renderGroup` は「同じ group の track を同時に描画する SHOULD」の表明であり、購読している音声と映像を常に 1 つの時間軸で扱うことで満たす。catalog の `renderGroup` を読んで時間軸を分けることはしない
- 同期の値は `devtools/src/signals/subscriber.ts` の signal に持たせ、`window.moqtDevTools` と `data-testid` から読めるようにする。値は 0635 の `AvSyncStats` と同じ 5 つにする (`skewMs` / `presentationDelayMs` / `targetLatencyMs` / `targetLatencyLimitedMs` / `audioClockFallback`)。画面のラベルはフィールド名と 1 対 1 に対応する英語表記にし、`data-testid` は既存と同じ kebab-case にする (例: `subscriber-av-sync-skew` / `subscriber-av-sync-presentation-delay` / `subscriber-av-sync-target-latency` / `subscriber-av-sync-target-latency-limited` / `subscriber-av-sync-audio-clock-fallback`)。更新は既存の統計と同じ `PLAYBACK_TIMING_PUBLISH_INTERVAL_MS` (500 ms) の定期反映に混ぜる
- jitter buffer が無効のときは映像を時間軸へ記録しない (現状どおり)。同期しないまま音声だけ目標時刻に合わせると映像とずれるため、jitter buffer が無効のときは音声も時間軸へ記録せず到着基準 (`targetStartSeconds: null` / `enforceTarget: false`) にする。このとき 5 項目はすべて既定値 (null / 0 / false) になるが、同期の推定として意味を持たないため、無効中は統計の snapshot を既定値に固定することを明示の実装要件にする (jitter buffer が有効に戻ったら作り直した時間軸で推定をやり直す)。同期の完了条件は jitter buffer が有効 (既定) のときの話とする
- 音声だけを購読しているときは映像の時間軸が無いため同期の推定は出さない (5 項目は既定値に固定する)。統計の定期反映は映像の購読を始める経路 (`startPlaybackTiming`) に乗せる
- 音声は既定で再生しない (`audioPlaybackEnabled` が false)。`AudioContext` も再生を始めたときに作るため、音声の `observe` と `AudioClockBridge` の配線は音声の再生を始めた時点からにする。再生していない間は映像だけが時間軸へ記録され、`skewMs` は null になる
- 音声も TIMESTAMP の種類 (Timescale の有無) を持つ。映像の `timestampKind` と同じように、Timescale がある TIMESTAMP (メディア時刻) の音は壁時計ではないため `observe` せず、`targetStartSeconds: null` / `enforceTarget: false` で到着基準にする。時間軸の `presentationPerformanceMs` が null を返したとき (TIMESTAMP を持たない、Timescale がある、基準の差が閾値を超えて共有が切れた) も同じフォールバックにする
- ライブラリ側の 0635 と同じ計算を使う。共有するのは「表示時刻の 3 項」「上限を `max` の側にだけ掛けること」「基準の差の閾値とフォールバック」「`AudioClockBridge` の換算と不感帯 (`AUDIO_CLOCK_DEADBAND_MS` = 30 ms)」「`recordPresentation` の実績」である
- 0763 で publisher が catalog に載せる `targetLatency` (devtools の URL クエリは `targetLatency` / `renderGroup`) をそのまま使う。0763 の完了が本 issue の前提になる

## 完了条件

- devtools で音声と映像が同じ時間軸 (`PlaybackTimeline`) で再生される。音声も `observe` され、`AudioPlayoutScheduler` に目標の開始時刻が渡る (音声の再生を始めたときから)
- `targetLatency` の解決が純関数 (`src/msf/tracks.ts`) として切り出され、ライブラリと devtools の両方がそれを使っている (規則が 2 か所に無い)。規則の単体テストは純関数を置く `src/msf/tracks.ts` 側 (`src/msf.test.ts`) に置く。固定する規則は 7 通り: 両方に無い / 片方にだけある / 両方にあって同じ / 同じ `renderGroup` で異なる (通知して大きい方) / 同じ `altGroup` で異なる (通知して大きい方) / group が無いか異なる (通知しない) / `isLive` が false のトラックの値を無視する (§5.2.8 の MUST)。上限による切り下げはキュー長とフレーム間隔に依存するため純関数では決まらず、`src/playbackTimeline.test.ts` の既存テストが持つ
- `targetLatency` 未設定時と `isLive` が false のときのフォールバックが、同じ純関数の単体テストで固定されている (純関数が `null` を返すこと)。`null` を渡された時間軸が揺らぎから求めた再生の遅れだけを使うことは `src/playbackTimeline.test.ts` の既存テストが持つ
- `window.moqtDevTools` の統計と `data-testid` に同期の 5 項目 (`skewMs` / `presentationDelayMs` / `targetLatencyMs` / `targetLatencyLimitedMs` / `audioClockFallback`) が出る。5 項目は 0635 の `AvSyncStats` と同じ意味にするが、型は devtools の統計の形に合わせる (`skewMs` / `presentationDelayMs` / `targetLatencyMs` は `number | null`、`targetLatencyLimitedMs` は `number` (未購読では 0)、`audioClockFallback` は `boolean` (未購読では false))。E2E (`tests/e2e/`) は「項目が公開され、未購読ではこの既定値であること」を確かめる (relay を起動しないため、同期の数値そのものは単体テストで固定する)
- 0763 で足した devtools の `Target Latency` / `Render Group` の選択が UI → URL → 復元まで動くことを E2E で確かめる (`tests/e2e/devtools-audio.spec.ts` の音声設定と同じ形。`data-testid` は `target-latency` / `render-group`)。0763 のレビューではこの往復が未カバーだった
- publisher 側の実機確認として、`Target Latency` を `Unset` / `0` / `100` にして配信し、catalog に載る値がそれぞれ「キーが無い」/ `0` / `100` になることを確かめる (0763 のレビューでは、devtools の設定から catalog への配線のうち実配信の経路が未検証のまま残っている)
- 同期の数値の導出 (純関数の解決規則、フォールバック、統計の既定値) は単体テストで固定する
- `vp check` / `tsc --noEmit` / `vp test run` / `vp run e2e-test` が通る

## 実機での確認 (E2E では確かめられない)

relay と devtools の publisher / subscriber を実機で動かし、120 秒程度の連続再生で A/V のずれが ±50 ms に収まることを確かめる。ずれの予算は時計の対応付けの不感帯 (`AUDIO_CLOCK_DEADBAND_MS` = 30 ms) と映像の描画の遅れ (`PlayoutBuffer` が `MAX_PRESENTATION_LAG_MS` = 20 ms を超えて遅れたフレームを捨てる) である (0635 が同じ条件を持ち、実機の確認を本 issue に渡している)。

- 条件: jitter buffer 有効 (既定)、Play Audio を ON
- publisher に `targetLatency` を指定し、`window.moqtDevTools.getSubscriber(id)` の統計と `data-testid` に出る `targetLatencyMs` がその値になること (`targetLatencyLimitedMs` が 0 でないときは上限で切り下げられている)
- 判定の対象は `PlaybackTimeline` の表示時刻が決まる区間 (音声の予約時刻と映像の表示時刻が `null` でない区間) にする。`audioClockFallback` は「`getOutputTimestamp()` を使えず `currentTime` で代用しているか」であり、代用中でも対応は取れている (出力遅延を含まないだけ)。逆に一度も `update` していない間は対応が無いまま false になるため、`audioClockFallback` の真偽ではなく表示時刻が決まるかどうかで判定する
- `audioClockFallback` が true の区間 (代用中で音声の出力遅延が加わる) は ±50 ms の判定の対象外にする (0635 と同じ)。これは予算の条件であり、上の判定区間の選び方とは役割が別である
- 音声の TIMESTAMP がドリフトしている間 (0754) は基準の差が閾値を超えて共有が切れるため、判定の対象外にする

## 変更対象

- `src/msf/tracks.ts`: `targetLatency` を解決する純関数を切り出す。形は `effectiveTargetLatencyMs(track: CatalogTrack | null): number | null` と `resolveSharedTargetLatencyMs(audio: CatalogTrack | null, video: CatalogTrack | null): { value: number | null; conflict: boolean }` を想定する (共有の値を決める規則と、同じ render group / alternate group で値が異なるかの通知要否を返す)。`getTracksByRenderGroup` と同じ場所。devtools は `src/msf/tracks.ts` を直接 import する (devtools は既に `src/playbackTimeline.ts` を直接 import している。公開 API (`src/msf.ts` / `src/index.ts`) には足さないため、`CHANGES.md` のライブラリ側のエントリは不要)
- `src/createMediaSubscriber.ts`: 切り出した純関数を使う (挙動は変えない。`resolveSharedTargetLatencyMs` は通知の扱いだけを持つ)
- `devtools/src/hooks/useSubscriber.ts`: 音声の `observe` と `AudioClockBridge` の配線、切り出した純関数での `targetLatency` の解決、時間軸を作り直すたびの `setTargetLatencyMs`、`recordPresentation` の記録、jitter buffer 無効時の音声のフォールバック
- `devtools/src/signals/subscriber.ts`: 同期の統計の signal
- `devtools/src/testApi.ts`: `window.moqtDevTools.getSubscriber(id)` の統計に同期の値を足す
- `devtools/src/components/SubscriberPanel.tsx`: `data-testid` で読める表示 (既存の `subscriber-playout-delay` と衝突しない名前)
- テスト: 純関数のテストは `src/msf.test.ts` に足す (ブラウザ API を使わないため Fake は不要)。devtools 側の配線 (音声の `observe`、`AudioClockBridge`、`recordPresentation`) は接続と `AudioContext` が要るため単体テストでは観測せず、実機で確かめる (`devtools/src/testSupport/fakes.ts` に `AudioContext` / `AudioData` の Fake は無く、配線のテストのために Fake を増やすことは本 issue ではしない)。型キャストでの置き換えもしない (AGENTS.md のモック・スタブ禁止と `testSupport/fakes.ts` の方針に従う)。E2E は `tests/e2e/` の既存の形に合わせる
- `CHANGES.md`: `## develop` に `[ADD]` を 1 件 (moqt-devtools)。ライブラリ側の変更ではないため別エントリにする

## 実装順

0. 同じ `devtools/src/hooks/useSubscriber.ts` を対象にする 0630 (未着手) が先に入るとパスが変わるため、着手前に 0630 の状態を確認する
1. `targetLatency` / `isLive` の解決を `src/msf/tracks.ts` の純関数として切り出し、`createMediaSubscriber` をそれに載せ替えたうえで、規則を単体テストで固定する
2. 音声の `observe` と `AudioClockBridge` の配線、`setTargetLatencyMs` の反映、`recordPresentation` の記録を足す
3. signal・`window.moqtDevTools`・`data-testid` に同期の 5 項目を出す
4. E2E に「項目の公開と null」を足し、`CHANGES.md` を更新する
5. 実機で 120 秒の連続再生を確かめる (この段階は自動化しない)

0763 が完了していることを前提にする (publisher が catalog に `targetLatency` を載せていないと、実機で確かめられない)。

## 参照

- draft-ietf-moq-msf-01 §5.2.8 (Target latency: 符号化から表示までの wallclock の差。宣言が無く `isLive` が true のときは購読側が遅延を選んでよい MAY。同じ render group と alternate group の track は同一の値でなければならない MUST)
- draft-ietf-moq-msf-01 §5.2.11 (Render group: 同じ group の track は同時に描画する SHOULD)
- draft-ietf-moq-msf-01 §5.2.7 (isLive: トラックに新しい Object が追加されるかの表明)。isLive が false なら targetLatency を無視する MUST は §5.2.8
- draft-ietf-moq-loc-04 §2.3.1.1 (Timestamp: Timescale が無ければ Unix epoch マイクロ秒)
- 0635 (ライブラリ側の A/V 同期。時間軸・統計 `AvSyncStats`・上限とフォールバックの規則を持つ)
- 0762 (映像の jitter buffer を `src/` へ移した。devtools が `PlayoutBuffer` を使う形になった)
- 0763 (publisher が catalog に `targetLatency` と `renderGroup` を載せる。本 issue の前提)
- 0754 (音声の TIMESTAMP のドリフト。未解決。実機の判定ではドリフト中を対象外にする)

## 解決方法

{未着手}
