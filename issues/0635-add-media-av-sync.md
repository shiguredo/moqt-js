# 音声と映像を LOC Timestamp と targetLatency で同期して再生する

- Created: 2026-09-20
- Completed: {YYYY-MM-DD}
- Branch: feature/add-media-av-sync
- Polished: 2026-09-26

## 目的

MSF は `renderGroup` が同じ track を「同時に描画するよう設計されている」と定め (draft-ietf-moq-msf-01 §5.2.11)、`targetLatency` を「符号化から表示までの wallclock の差」と定義する (§5.2.8)。LOC の Timestamp は Timescale が無ければ Unix epoch マイクロ秒の壁時計である (draft-ietf-moq-loc-04 §2.3.1.1)。

この 3 つを組み合わせると、表示時刻を `Timestamp + targetLatency` の 1 つの式で決められる。`createMediaSubscriber` はこの計算を行っておらず、音声と映像が別々の基準と別々の時計で再生されるため A/V 同期が成立しない。

## 現状

- 映像の表示時刻は `src/playoutBuffer.ts` の `PlayoutBuffer` が決める。`TIMESTAMP + 基準の遅れ + 再生遅延` を `performance.now()` 軸で求め、`src/createMediaSubscriber.ts` の `scheduleVideoFrameDrain` / `writeDueVideoFrames` が表示時刻を過ぎたフレームだけを `videoWriter.write` する。`write` した時点でトラックへ出るため (0762)、表示時刻を制御する手段は write する時機だけである
- 音声の鳴らす時刻は `src/audioPlayout.ts` の `AudioPlayoutScheduler` が決める。最初の音の到着 + 80 ms (`AUDIO_PLAYOUT_DELAY_SECONDS`) を基準に、`AudioContext.currentTime` 軸で `source.start(decision.startAt)` に渡す時刻を決める
- 映像の基準 (復号の出力の遅れの最小値) と音声の基準 (最初の音の到着) はトラックごとに独立に決まり、軸も `performance.now()` と `AudioContext.currentTime` で別である。両者を対応づけるコードは無い
- カタログの `targetLatency` / `renderGroup` は `src/msf/types.ts` の `CatalogTrack` にあり、`src/msf/catalogTrackValidation.ts` が値の型と `targetLatency` と `buffers` の併存禁止 (§5.2.8 / §5.2.9) を検証するが、再生時刻の決定に読むコードは無い (`createMediaPublisher` と devtools の publisher も catalog に載せていない)
- publisher 側は映像を `WallClockMapper` で、音声を `LOC.toUnixEpochMicroseconds` で、どちらも壁時計の TIMESTAMP にする。ただし受信側で測った音声の遅れが伸び続ける問題が 0754 で未解決であり (実測で 336 秒に 16 秒、原因は未特定)、音声については送信側の前提が整っていない
- 0762 は「映像と音声を同じ時計に揃えることはこの issue ではしない」としている。2 つの時計の橋渡しは本 issue が引き取る

## 設計方針

### 表示時刻を 1 つの式で求める

- 計算の軸は受信側の壁時計の ms (`performance.timeOrigin + performance.now()`) にする。LOC Timestamp は µs なので 1000 で割って ms にする
- 「基準の遅れ」は「復号の出力の壁時計の時刻 - TIMESTAMP」の直近 10 秒の窓の最小値 (ms) である。受信側と送信側の時計のずれと、経路と復号の最小遅延を含む (基準は表示待ちのキューに入った時刻ではなく復号の出力の時刻で測る。表示できる時刻には復号の時間も含まれるため)。値は数十 ms から時計のずれの分だけ大きく、負にもなりうる
- 「再生遅延」は「復号の出力の遅れ - 基準の遅れ」の窓の百分位から求めた遅れ (ms) である (現在の `PlayoutBuffer` の規則をトラックごとの窓に一般化する)
- 「表示の遅れ」= 基準の遅れ + `max(targetLatency (ms), 再生遅延 (ms))`。これが目標の表示時刻の元になる
- 目標の表示時刻は次の 2 つの式で表す (同じ値になる)
  - 壁時計の ms: `Timestamp (µs) / 1000 + 表示の遅れ (ms)`
  - `performance.now()` の ms: `Timestamp (µs) / 1000 - performance.timeOrigin + 表示の遅れ (ms)`
- 共有の「基準の遅れ」は、音声と映像のトラックごとの最小値の**大きい方**にする。復号の遅い側に合わせるのが安全側であり (表示が期限より前にならない)、両方に同じ値を与えるため同期する。トラックごとの基準をそのまま使うと、復号の時間の差がそのまま A/V のずれになる
- ただし 2 つのトラックの基準の差が、表示待ちのキューが吸収できる長さを超えたら、基準を共有しない。閾値は `PLAYOUT_BASE_MAX_DIFFERENCE_MS` = キューが吸収できる表示の遅れ (`PLAYOUT_QUEUE_CAP_MS` = (`JITTER_BUFFER_MAX_QUEUED_FRAMES` - `PLAYOUT_QUEUE_HEADROOM_FRAMES`) 枚 × フレーム間隔。30 fps で約 667 ms、60 fps で約 333 ms、120 fps で約 167 ms) - `max(targetLatency, 再生遅延)` とし、下限を 100 ms にする (共有とフォールバックの往復を防ぐ)。`src/playbackTimeline.ts` に置く
  - 引くのは `max(targetLatency, 再生遅延)` の側だけである。基準の遅れは受信側と送信側の時計のずれであり、キューが保持する時間は「表示時刻 - 復号の出力時刻」= 2 つのトラックの基準の差 + `max(targetLatency, 再生遅延)` で、基準の遅れそのものは含まない
- 差が閾値を超えたときは、大きい方のトラックは TIMESTAMP が壁時計からずれている (0754 で未解決の音声のドリフトなど) とみなし、そのトラックを TIMESTAMP を使わないフォールバック (到着基準の再生) に落とし、もう片方は自分の基準を使う。共有を続けると、ずれた側の基準が窓の最小値として単調に増え、映像の表示時刻が未来へ伸びて 1 枚も描かれなくなる。フォールバックに落ちたトラックも基準の観測は続け、差が閾値を下回ったら共有へ戻す
- 共有の「再生遅延」は、音声と映像それぞれの窓から求めた遅れの**大きい方**にする (音声は `AUDIO_PLAYOUT_DELAY_SECONDS` = 80 ms を下限にする)。片方の遅れをもう片方に合わせることで、片方だけが途切れない。映像も 80 ms 以上遅れて出ることになるが、同期には必要である
- `targetLatency` が無いとき、`isLive` が false のときは `targetLatency` を使わず、再生遅延だけを使う (フォールバック)
- 表示の遅れの上限は `MAX_PLAYOUT_DELAY_MS` = 500 ms と、キューが吸収できる表示の遅れ (`PLAYOUT_QUEUE_CAP_MS`。30 fps で約 667 ms) の小さい方を `max(targetLatency, 再生遅延)` に掛ける。`targetLatency` がこれを超えるときは両方のトラックを同じ値に切り下げ、切り下げた分を統計に出す (同期は保たれる)
  - 5000 ms のような大きい `targetLatency` を守るには、復号を表示時刻の近くまで遅らせて保持するフレーム数を減らす必要がある。これは受信経路 (Group の順序とキーフレーム待ち) に踏み込む別の作業であり、本 issue では扱わない
  - 上限は基準の遅れではなく「表示の遅れ - 基準の遅れ」に掛ける。基準の遅れは時計のずれそのものであり、切り下げるとすべてのフレームが期限切れになる
- Timescale がある TIMESTAMP と TIMESTAMP の無いフレームは壁時計ではないため、この式を使わない。音声は到着基準の並べ方に、映像は `PlayoutBuffer` の TIMESTAMP 無しの扱い (届いた順に 1 枚ずつ) にフォールバックする
- TIMESTAMP の飛び (基準の遅れが 2 秒以上動いた場合。`PLAYOUT_DISCONTINUITY_MS`) は、トラックごとではなく共有の時間軸ごと取り直す。両方のトラックが同じだけ動くため同期は保たれる

### 音声の鳴らす時刻

- 目標の表示時刻を `AudioContext.getOutputTimestamp()` が返す `{ contextTime, performanceTime }` で `AudioContext.currentTime` の秒に換算し、`start(when)` に渡す。`contextTime` はデバイスが今鳴らしている位置、`performanceTime` はそれを `performance.now()` と同じ原点で表した時刻である
- 目標の表示時刻 `P` (`performance.now()` の ms) に鳴らすには `contextTime + (P - performanceTime) / 1000` を渡す
- 対応は予約のたびに取り直し、直前の値との差が 30 ms 未満なら前の値を使い、差が大きいときも 1 回の変更を 80 ms までにする (libwebrtc の `video/stream_synchronization.cc` の不感帯と変更上限と同じ考え方)。不感帯の 30 ms はそのまま A/V のずれとして残るため、ずれの予算に含める
- `getOutputTimestamp()` が未開始 (`contextTime` と `performanceTime` が 0) のときは `currentTime` と `performance.now()` の差で代用する。この差は音声の出力遅延の分だけ後ろにずれるが、ずれは音声側に一定に乗るだけである。出力遅延は環境によって数十 ms から 100 ms を超えることがあるため、代用している間は後述の ±50 ms の判定の対象外とし、統計に代用中であることを出す
- 目標の時刻を過ぎて届いた音は捨てる (映像が表示時刻を過ぎたフレームを捨てるのと同じ)。**基準の取り直しはしない**。取り直すと音声だけが後ろへずれ、共有の時間軸を使う映像とずれる。揺らぎは共有の再生遅延が吸収し、それを超えて遅れて届いた音だけを捨てる (現在は基準の取り直しで遅れを積み上げていた)。音を 1 つ捨てた分のずれは 1 フレーム (音声の符号化の単位。Opus で 20 ms) で、次の音から目標へ戻る
- 例外は TIMESTAMP の飛び (上記の 2 秒) で、このときは共有の時間軸ごと取り直す
- 「音声だけを購読している」は `videoTrackInfo` が null のとき (映像を要求していない、または要求したがカタログで解決できなかった) とする。このときは揃える相手がいないため、目標の時刻に届かなかった音は捨てずに基準を取り直す (現在の挙動。音の連続性を優先する)。取り直し先は時間軸が使っている再生遅延 (下限 80 ms) とし、取り直した基準 (timestamp と時刻の組) を時間軸へ返して同じマッピングを保つ。両方を購読しているときは捨てる。壁時計の TIMESTAMP を持たないときは常に現在の基準の決め方を使う。`reset()` は購読のやり直しと AudioContext の作り直しで基準を消すために残す
- 並べすぎの上限は、現在の `AUDIO_PLAYOUT_MAX_DELAY_SECONDS` (300 ms) を「再生遅延 + 220 ms (300 ms - 80 ms)」に読み替える。判定は現在の実装と同じく「今 + 上限」と「前の音の終わり」の遅い方で行う。絶対値 300 ms のままだと、再生遅延が 500 ms のときに鳴らす音をすべて捨てて無音になる。並べすぎの是正は現在の「基準を音の長さだけ前に寄せる」ではなく、その音を捨てて目標へ戻す (目標より前に鳴らすと映像とずれるため)
- `AudioContext` は既定 128 フレーム (48 kHz で約 2.67 ms) ごとに描画し、`currentTime` もその単位で進む。`start(when)` はサンプル単位で正確に予約できるが、`currentTime` の読み取りと予約の間の遅れがあるため `AUDIO_PLAYOUT_MIN_LEAD_SECONDS` = 10 ms の余裕はそのまま置く

### targetLatency と isLive の解決

- `targetLatency` と `isLive` は、起動時に `extractTrackInfo` が解決した `audioTrackInfo` / `videoTrackInfo` (`CatalogTrack`) から読む。カタログ更新で track info を作り直す経路が無いため、起動時の値を固定で使う
- `isLive` が false のトラックの `targetLatency` は無視する (§5.2.8 の MUST)
- 片方だけを購読しているときは、そのトラックの `targetLatency` をそのまま使う (揃える相手がいないため)
- 両方を購読しているときは、次の順で使う値 1 つを決める
  - どちらにも無い、またはどちらかが `isLive` false で使えないときは、`targetLatency` を使わずフォールバックする
  - 片方にしか無いときは、もう片方は遅延を選んでよい (§5.2.8 の MAY) ため、その値を使って揃える
  - 両方にあって同じときはその値を使う
  - 両方にあって異なるときは、`renderGroup` が両方にあって同じ場合 (または `altGroup` が両方にあって同じ場合) に限り §5.2.8 の MUST 違反であるため `onError` で通知する。どちらも無い、または異なる場合は仕様に反しないため通知しない。どちらの場合も大きい方を使う (小さい方の要求より早く出さない)
- `renderGroup` の一致は同期の前提にしない。値が 1 つに決まるかどうかで判断する (renderGroup が違っても同じ値なら揃う)

### 変更対象

- `src/playbackTimeline.ts` (新規): 音声と映像で共有する表示時刻の時間軸。ブラウザ API に依存せず時刻を引数で受ける。基準の遅れ・再生遅延・フレーム間隔 (現在の `PlayoutBuffer` の規則をトラックごとの窓に一般化) の学習、キューが吸収できる表示の遅れと基準の差の閾値の計算、基準の差が大きいときのフォールバック、`targetLatency` の解決結果の適用と切り下げ、目標の表示時刻 (壁時計の ms と `performance.now()` の ms)、同期ずれの推定を持つ
- `src/playbackTimeline.test.ts` / `src/playbackTimeline.prop.ts` (新規): 上記の規則と 120 秒のシミュレーション
- `src/playoutBuffer.ts` / `src/playoutBuffer.test.ts` / `src/playoutBuffer.prop.ts`: 基準と再生遅延の学習を `playbackTimeline.ts` へ移し、`PlayoutBuffer` は共有の時間軸が決めた表示時刻で選ぶキューにする
- `src/audioPlayout.ts` / `src/audioPlayout.test.ts` / `src/audioPlayout.prop.ts`: `schedule` は共有の時間軸が決めた目標の開始時刻と、目標を守るか (音声と映像の両方を購読しているか) を引数で受け取り、連続性 (重ならない・隙間を残す・目標を過ぎたら捨てる・並べすぎたら捨てる) の規則を持つ。目標を守らないときは現在の基準の取り直しを使う。上限の判定を再生遅延 + 余裕に変える
- `src/createMediaSubscriber.ts` / `src/createMediaSubscriber.test.ts`: `CatalogTrack` から `targetLatency` を解決して時間軸へ渡し、音声は `getOutputTimestamp` で換算した時刻を、映像は共有の時間軸の表示時刻を使って write する。同期ずれを統計に出す
- `src/codec/types.ts` / `src/index.ts`: 統計型 `AvSyncStats` を足し、`MediaReceiverStats` から読めるようにする
- `devtools/src/hooks/useSubscriber.ts`: 同じモジュールを使うため、新しい API に合わせて呼び出しを直す。devtools の音声と映像を同期させることと統計の露出は 0636 が持つ (本 issue では今の挙動を変えない)
- `docs/HIGH_LEVEL_API.md`: `MediaReceiverStats` の統計の定義を実装に合わせる
- `CHANGES.md`: `MediaReceiverStats` の変更を `## develop` に `[CHANGE]` で載せる

### 統計

- `MediaReceiverStats` に `avSync: AvSyncStats | null` を足す。`AvSyncStats` は次を持つ
  - `skewMs`: 同期ずれの推定値 (ms)。映像の表示が音声より遅れていれば正
  - `presentationDelayMs`: 表示の遅れ (ms)。TIMESTAMP から表示時刻までの差で、時計のずれの分だけ負にもなる。基準が未確立なら null
  - `targetLatencyMs`: 解決して使っている `targetLatency` (ms)。無い、または使えないときは null
  - `targetLatencyLimitedMs`: 上限に収まらず切り下げた分 (ms)
  - `audioClockFallback`: `getOutputTimestamp()` の代用を使っているか
- `skewMs` は、直近に鳴らすと決めた音声の `(timestamp, 鳴る時刻)` と、直近に write すると決めた映像の `(timestamp, 表示時刻)` から、`(映像の表示時刻 - 映像の timestamp) - (音声の鳴る時刻 - 音声の timestamp)` を求める。どちらも `performance.now()` の ms に換算し、timestamp は µs から ms に換算する。両方が直近 1 秒以内の実績を持つときだけ値を返す。捨てた音と write しなかったフレームは実績に含めない (捨てが 1 秒を超えて続くと実績が古くなり null になる)
- `avSync` は次のとき null にする: 音声と映像のどちらかを購読していない、またはどちらかが壁時計の TIMESTAMP を使わないフォールバックに落ちている (映像の表示時刻が決まらない、音声の timestamp がメディア時刻になるため比較できない)。基準の差が閾値を超えて到着基準の再生に落ちた場合 (2 つのトラックは壁時計の TIMESTAMP を使い続ける) は null にしない
- `skewMs` は「鳴らす / 書くと決めた時刻」の差であり、実際に音が出るまでの出力遅延と、映像が実際に表示されるまでの遅れ (`MAX_PRESENTATION_LAG_MS` = 20 ms と表示周期) は含まない。同期の判定はこの定義で行い、体感のずれの測定は devtools の 0636 が持つ

## 完了条件

- 目標の表示時刻が `Timestamp (µs) / 1000 + 表示の遅れ (ms)` として計算され、`performance.now()` の ms では `performance.timeOrigin` を引いた同じ値になる
- 表示の遅れ = 基準の遅れ + `max(targetLatency (ms), 再生遅延 (ms))` であり、上限 (`MAX_PLAYOUT_DELAY_MS` と `PLAYOUT_QUEUE_CAP_MS` の小さい方) がこの `max` の側にだけ掛かる
- 音声の予約時刻と映像の write する時刻が同じ目標の表示時刻から換算される (`AudioContext.getOutputTimestamp` と `performance.now()`)
- `isLive` が false のトラックの `targetLatency` を無視する
- `targetLatency` が無い / 片方にだけある / 両方にあって同じ / 両方にあって異なり同じ renderGroup (MUST 違反、`onError` を通知) / 両方にあって異なり同じ altGroup (通知) / 両方にあって異なり renderGroup も altGroup も無いか異なる (通知しない) / 片方だけの購読 / 上限を超えて切り下げる、の各場合の扱いがテストされている
- Timescale がある TIMESTAMP と TIMESTAMP の無いフレームは `targetLatency` を使わず、現在の扱いにフォールバックする
- 音声の TIMESTAMP が壁時計からドリフトする入力 (0754 の実測と同じ毎秒 48 ms) で、2 つのトラックの基準の差が `PLAYOUT_BASE_MAX_DIFFERENCE_MS` を超えたら基準を共有せず、映像が表示され続ける (フレームが捨てられ続けない)。30 fps と 60 fps の両方で確かめる
- 音声は目標の時刻を過ぎて届いた音を捨て、基準を取り直さない。捨てた後の音が目標へ戻る
- 音声だけを購読しているときは、基準の取り直しで音が連続すること (現在の挙動)
- 120 秒の到着列 (揺らぎの p95 が 50 ms 程度、数十秒に 1 回 200 ms 程度の遅れ、`performance.now()` と `AudioContext.currentTime` のドリフト) を与える PBT で、同時刻の音声と映像の目標の表示時刻の差、および実績から求めた `skewMs` が ±50 ms 以内に収まる。内訳は時計の対応付けの不感帯 30 ms + 映像の write の遅れ (`MAX_PRESENTATION_LAG_MS` = 20 ms)。`getOutputTimestamp()` の代用を使っている間は出力遅延が加わるため対象外とする
- 再生遅延が上限に達した状態で、あるトラックの窓の遅れ (基準の遅れを引いた揺らぎ) が共有の再生遅延を超えた場合に、目標を過ぎた音が捨てられて目標へ戻る。捨てが 1 秒を超えて続くと `skewMs` は null になる (鳴らすと決めた音が更新されないため)
- `getStats()` の `avSync` から `skewMs` / `presentationDelayMs` / `targetLatencyMs` / `targetLatencyLimitedMs` / `audioClockFallback` が読める
- `docs/HIGH_LEVEL_API.md` の `MediaReceiverStats` の定義が実装と一致する
- 実機での 120 秒の連続再生は devtools の 0636 が確かめる (本 issue の対象外)
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 実装順

- `src/createMediaSubscriber.ts` / `src/codec/types.ts` / `src/createMediaSubscriber.test.ts` を扱う 0654 (`stop` / `close` の解放経路の全面改修) と、その後に着手する 0657 の完了後に本 issue に着手する (0649 は closed のため対象外)。0654 の `disposeAllResources()` の初期化フィールドの列挙に、本 issue が足す表示待ちのキュー・時間軸・予約の解除・統計も加える必要がある
- 0663 (受信経路のテスト) と同じテストファイルを扱うため、本 issue を先に実施し、0663 は本 issue の完了後に `src/createMediaSubscriber.test.ts` を新しい契約へ合わせる
- 0753 (音声の遅れが戻らない) は、本 issue で音声の再生の遅れが共有の値になり、基準の取り直しもやめるため前提が変わる。本 issue を先に実施し、0753 は本 issue の完了後に「共有の再生遅延を目標へ戻す」問題として作り直す (0753 の参照先 `devtools/src/utils/playoutBuffer.ts` も、本 issue の後の実体に合わせて `src/playbackTimeline.ts` へ直す)
- 0636 (devtools の A/V 同期) は本 issue の後に着手する。devtools は `src/playbackTimeline.ts` を直接 import して同じ計算を使う (0636 の「devtools は `createMediaSubscriber` を使わないため実装は共有できない」という記述は現行コードに合わないため、0636 側の更新が要る)
- 0754 は未解決のままとする。本 issue はドリフトを検出してフォールバックする (上記)。実機の確認は 0754 の完了後に 0636 が行う

## 参照

- draft-ietf-moq-msf-01 §5.2.7 (isLive: トラックに新しい Object が追加されるかの表明)
- draft-ietf-moq-msf-01 §5.2.8 (targetLatency: 符号化から表示までの wallclock の差 (ms)。isLive が false なら無視する MUST。同じ render group と alternate group の track は同一の値でなければならない MUST。`buffers` と併存しない MUST NOT。無い場合は遅延を選んでよい MAY)
- draft-ietf-moq-msf-01 §5.2.9 (buffers: targetLatency と併存しない)
- draft-ietf-moq-msf-01 §5.2.11 (renderGroup: 同じ group の track は同時に描画する SHOULD)
- draft-ietf-moq-loc-04 §2.3.1.1 (Timestamp: Timescale が無ければ Unix epoch マイクロ秒の壁時計)
- draft-ietf-moq-loc-04 §2.3.1.2 (Timescale: あるときの Timestamp はメディア時刻)
- 0762 (映像の表示時刻を決める `PlayoutBuffer`。0762 は「映像と音声を同じ時計に揃えることはこの issue ではしない」としている)
- 0636 (devtools の A/V 同期。`src/playbackTimeline.ts` の計算を devtools が直接 import して共有し、実機のずれの測定と統計の露出を持つ)
- 0754 / 0753 (音声の TIMESTAMP のドリフトと、再生の遅れが戻らない問題。音声を絶対時刻に載せる前提に関わる)
- `AudioContext.getOutputTimestamp()` (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)
- libwebrtc `video/stream_synchronization.cc` の `ComputeDelays` (相対遅延だけを制御し、jitter 由来の下限と同期由来の下限を max で合成する。不感帯 30 ms、1 更新あたりの変更上限 80 ms、EMA の係数 1/4、相対遅延が ±10 秒を超えたら制御を放棄する) と `modules/video_coding/timing/timing.cc` の `VCMTiming::RenderTime` (表示時刻を遅延の下限と上限で clamp する)。libwebrtc は音声も映像も同一のローカルクロックで扱うため、ブラウザの 2 つの時計の対応付けは本リポジトリ固有の課題である

## 解決方法

{未着手}
