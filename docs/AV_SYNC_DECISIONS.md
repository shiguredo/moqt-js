# A/V 同期と再生の決定の記録

## 概要

A/V 同期と再生まわりで入れた判断 (閾値・保持・検出・追いつき・補正) を、値・根拠・副作用・
再考の条件・計器の 5 点で並べる。目的は「なぜその値なのか」「どうなったら見直すのか」を
症状が出る前に残し、再考すべきときに再考できるようにすることである。値だけを見て動かすと、
その値が守っている性質 (相手側のトレードオフ) を壊す。

対象は、2026-10 の 1 週間で `f13db71` (A/V 同期が時計のずれを相手側の遅延へ移すのを止める)
から `c3e00bf` (受信側が基準の共有を解除した後、差が戻ったら保持を待たずに戻す) までに
入れた判断である。実装の仕様は `docs/HIGH_LEVEL_API.md` が持つ。ここは判断の理由と、
見直す手順を持つ。

読み方は次のとおり。

- **決めた値**: 定数と値。実装は `src/playbackTimeline.ts`、`src/audioTimestampClock.ts`、
  `src/audioPublishCatchUp.ts`、`src/audioDelayFeedback.ts` である
- **守っている性質**: その値が無いと壊れること
- **根拠**: 実測値と、どのコミットの計測か。実測が無い、または見積もりに留まるものは
  「根拠が薄い」と明記する
- **副作用とトレードオフ**: その値を選んだことで受け入れていること
- **再考の条件**: どうなったら見直すか。devtools の警告 (`Warnings` セクション) が出す
  条件と揃えてある
- **見る計器**: 見るべき値の名前。devtools の Subscriber / Publisher 統計と
  「Copy for LLM」に同じ名前で出る

## 決定の一覧

| #   | 決定                           | 主な値                                                                              | 主な計器                                                      |
| --- | ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | A/V 同期で合わせる量の上限     | 100 ms (`PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS`)                                    | `avSync.delays.*.syncExtraDelayMs`                            |
| 2   | 共有解除の保持と早期解除       | 30 秒 (`PLAYOUT_BASE_UNSHARED_HOLD_MS`) / 2 秒 (`PLAYOUT_BASE_UNSHARED_RELEASE_MS`) | `avSync.delays.unsharedReason`、`baseUnsharedReturnMs`        |
| 3   | ドリフト検出と持続性           | 50 ms (`PLAYOUT_BASE_DRIFT_MS`) / 6 秒 / 200 ms                                     | `avSync.delays.baseDriftMsPerSecond`                          |
| 4   | 音声の到着基準の遅れと閉ループ | 80〜100 ms / 閉ループ 80〜300 ms                                                    | `audio.playoutTiming.*`、`avSync.delays.audioDelayFeedback.*` |
| 5   | 配信側の TIMESTAMP 補正        | 窓 2 秒 / 上昇の上限 100 ms/秒 / 定着 5 秒 / 段差 200 ms                            | `audio.timestampOffset.*`                                     |
| 6   | 配信側の追いつき               | `max(60 ms, 床 + 40 ms)` / 再開 20 ms / `drop` と `keep`                            | `audio.catchUp.*`                                             |
| 7   | 受信側の再生の組み立て         | `AudioPlayoutSession` / `VideoPlayoutSession`                                       | `avSync.*`、`audio.playoutTiming.*`                           |
| 8   | 復号の出力と投入の対応づけ     | 1,000 マイクロ秒 (`DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS`)                      | `audio.playoutTiming.arrivalPlannedFrames`                    |

## 1. A/V 同期で合わせる量の上限

### 決めた値

- `PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` = 100 ms (`src/playbackTimeline.ts`)
- あわせて、不感帯は `SYNC_MIN_DELTA_MS` = 30 ms、戻す速さは
  `PLAYBACK_DELAY_DECAY_MS_PER_SECOND` = 20 ms/秒

### 守っている性質

2 つのトラックの表示時刻の差を不感帯 (30 ms) に収めること。ただし、合わせるのは「経路と
復号の遅い側」として説明できる分だけにする。差が動き続ける場合や大きすぎる場合は、合わせても
実際のずれは減らないまま、相手側の表示の遅れだけが伸びる。伸びた表示の遅れは上限
(`MAX_PLAYOUT_DELAY_MS` = 500 ms) に達すると戻せない。

### 根拠

`f13db71` (2026-10-09) で「差が動いたら時計のずれとみなし、合わせる量を 100 ms までに制限する」
として導入した。導入時の実測は「映像の表示遅延 483 ms を約 175 ms に、実時間のずれ 270 ms を
約 38 ms にする」である。実測の内訳は音声の基準が 313 ms、映像が 13 ms で、映像へ 378 ms を
足して表示の遅延が 483 ms になっていた (`src/playbackTimeline.ts` の
`PLAYOUT_MAX_COMPENSATED_DIFFERENCE_MS` のコメント)。

上限を時計のずれの証拠を待たずに常に掛けるのは、証拠を見る前に 600 ms の段差を合わせて映像を
500 ms 遅らせた実測があるためである (`176a433`、2026-10-09)。

**根拠が薄い点**: 100 ms という値そのものは「同じ publisher・同じ経路の 2 つのトラックで、
経路と復号の「最小」遅延がこれ以上違うことはない」という見積もりであり、2 つのトラックの
最小遅延の差の分布を測った記録は無い。実測で確かめたのは「上限を掛けた結果どうなったか」
だけである。

### 副作用とトレードオフ

補償した後に残るずれは `max(30 ms, |基準の差| - 100 ms)` になる。差が 130 ms を超えると、
超えた分は A/V のずれとしてそのまま残る。実測の 313 ms と 13 ms の例では、補償後も 200 ms の
ずれが残る。上限に張り付いたままになるため、ずれが残っていることが計器からは読み取りにくい
(これが警告 `syncExtraDelayPinnedAtLimit` を足した理由である)。

### 再考の条件

- `syncExtraDelayMs` が上限の 5 ms 以内のまま 10 秒以上戻らない (警告
  `syncExtraDelayPinnedAtLimit`)
- `avSync.skewMs` が 100 ms を超える状態が続く
- `baseDifferenceMs` が 130 ms 以上のまま安定している (上限に張り付く帯に入っている)

見直すときは、上限を上げる前に「差が本当に経路の差なのか、時計のずれなのか」を確かめる。
時計のずれなら上限を上げても残るずれは減らず、相手側の遅れだけが増える。

### 見る計器

- `avSync.delays.audio.syncExtraDelayMs` / `avSync.delays.video.syncExtraDelayMs`
- `avSync.delays.baseDifferenceMs`
- `avSync.delays.*.presentationDelayMs`
- `avSync.skewMs`

## 2. 共有解除の保持と早期解除

### 決めた値

- `PLAYOUT_BASE_UNSHARED_HOLD_MS` = 30 秒 (保持。`f13db71` で導入)
- `PLAYOUT_BASE_UNSHARED_RELEASE_MS` = 2 秒 (差が戻ったときの早期解除。`c3e00bf` で導入)

### 守っている性質

一度「基準を共有しない」と決めた後、閾値が動いてもすぐには戻さないこと。閾値は
「表示の遅れの上限 - そのトラックの遅延」で決まるため、jitter buffer の目標遅延が段差で
動くたびに閾値も動く。往復のたびに、足した分を戻して (間に合わないフレームを捨てる) すぐ
足し直す (表示が待って止まる) ことになる。

### 根拠

保持の 30 秒は、実測「差が 300 ms でほぼ動かないまま、音声の目標遅延が 380 ms と 100 ms を
行き来して閾値が 120 ms と 400 ms を行き来し、13 秒間に 5 回 共有と解除を往復した」から、
往復の周期より十分に長い値として置いた (`src/playbackTimeline.ts` の
`PLAYOUT_BASE_UNSHARED_HOLD_MS` のコメント)。

早期解除の 2 秒は、実測「CI の 4 vCPU の runner、run 38023970857 で、購読の直後に relay の
cache から届いた分をまとめて復号している間だけ差が 1 秒近く開き、復号が実時間に追いつくと
5 ms 前後へ戻った。この一過性の動きで解除した後、30 秒の保持がそのまま効き、25 秒の観測が
すべて解除のままになった」(`c3e00bf`) からである。2 秒は差の記録間隔 (250 ms) の 8 回分で
あり、実リレーの観測が待つ「基準の遅れが 3 秒動かないこと」(`tests/e2e/relay/audio-timestamp.spec.ts`
の `READY_SETTLED_MS`) より短いため、解除が観測の前に済む。

**根拠が薄い点**: 保持の 30 秒は「13 秒間で 5 回往復した」という 1 例から決めた値であり、
30 秒あれば往復しないという計測は無い。早期解除の 2 秒は「解除が早すぎることは無い」と
言えるが、「解除が遅れて観測に間に合わないことが無い」ことの根拠は、観測の待ち時間
(`READY_SETTLED_MS` = 3 秒) との比較だけである。

### 副作用とトレードオフ

- 解除のきっかけが「差の動き」ではなく「閾値の移動」だった場合、差が戻っていても 30 秒は
  共有が戻らない (その間 A/V の基準は別々に並ぶ)
- 逆に、きっかけが動きで差が戻った場合は 2 秒で戻る。2 秒の間は解除されたままである
- 保持は `lastUnsharedAtMs` を更新し続けるため、解除と保持を繰り返すと実質的に
  共有されないままになる

### 再考の条件

- `unsharedReason` が `hold` のまま 20 秒 (保持の 2/3) 以上続く (警告
  `unsharedHoldContinues`)。満了の手前で出し、「20 秒以上 A/V の基準が共有されていない」
  ことを見えるようにしている
- 早期解除が効かず、`baseUnsharedReturnMs` が `PLAYOUT_BASE_UNSHARED_RELEASE_MS` に
  届かないまま保持が満了する
- `unsharedReason` が `hold` と `none` の間で繰り返し動く (往復が再発している)

見直すときは、保持を短くするのではなく「閾値がなぜ動くのか」(jitter buffer の目標遅延の
段差) を先に見る。閾値が動かなければ保持は要らない。

### 見る計器

- `avSync.delays.unsharedReason`
- `avSync.delays.baseUnsharedReturnMs`
- `avSync.delays.baseDifferenceMs`
- `avSync.delays.presentationDelayCapMs`
- `avSync.delays.sharingBases`

## 3. ドリフト検出と持続性

### 決めた値

- `PLAYOUT_BASE_DRIFT_MS` = 50 ms (動いた幅。`9314980` で導入、`10f4215` で下限の考え方を追加)
- `PLAYOUT_BASE_DRIFT_CONFIRM_MS` = 6 秒 (離れた幅が続く時間)
- `PLAYOUT_BASE_DRIFT_STEP_MS` = 200 ms (待たずに段差とみなす幅)
- `PLAYOUT_BASE_DRIFT_WINDOW_MS` = 5 秒 (差の履歴を持つ長さ)
- `BASE_DIFFERENCE_QUIET_MS` = 5 ms (落ち着いているとみなす 1 回の変化)
- `BASE_DIFFERENCE_SETTLE_MS` = 3 秒 / `BASE_DIFFERENCE_START_MS` = 10 秒 (判定を始める条件)
- `BASE_DIFFERENCE_RECENT_WINDOW_MS` = 2 秒 (動きを見るための短い窓)

### 守っている性質

「差が大きいだけ」と「差が動き続けている」を分けること。差が大きいだけなら経路と復号の
遅い側であり、同期の制御で合わせられる。差が動き続ける場合は、片方の TIMESTAMP が壁時計から
ずれていくことであり (0754 の音声のドリフトなど)、合わせるともう片方の表示の遅れが上限まで
伸びて戻せなくなる。

### 根拠

- 実時間に対する時計の進み方の違いは 500 ppm (毎秒 0.5 ms) 未満であり、経路と復号の最小
  遅延の差も毎秒ミリ秒の桁でしか動かない。定常状態の差は 1 ms 程度しか動かない (実測)
- 0754 の音声のドリフトは毎秒 20〜50 ms で動く。この速さなら、段差とみなす幅 200 ms を
  超えるのは 4 秒程度であり、確認の 6 秒より早く検出できる
- 一過性の動き (読み出しが一瞬遅れた分) は実測で 95 ms 動いて戻る。動いた幅だけでは一過性か
  どうか分からないため、離れた幅が続く時間で見る (`612b78b`、2026-10-10)
- 購読の直後は、relay の cache から届いた分をまとめて復号しており、基準の遅れが数百 ms から
  数秒動く (実測: 音声の基準の遅れが 800 ms から 18 ms へ落ちた)。この動きを時計のずれと
  みなすと共有を 30 秒解除してしまう (実測: 1 vCPU の runner でも手元でも 5 回中 3 回起きた)。
  そのため落ち着くまで判定しない (`612b78b`)

**根拠が薄い点**:

- 50 ms という幅は「時計のずれ (毎秒 0.5 ms) や経路の最小遅延の動き (毎秒ミリ秒) より
  2 桁大きい」ことだけを根拠にしており、実際に観測される差の動きの分布 (誤検出と見逃しの
  境目) を測った記録は無い
- 200 ms の段差は、配信側の `AUDIO_TIMESTAMP_OFFSET_STEP_MICROS` (200 ms) と同じ値に
  揃えたもので、値そのものの根拠は「読み出しの遅れが 200 ms 以上ぶれて 0.5 秒続くことは
  考えにくい」という見積もりである
- 3 秒 / 10 秒 / 2 秒 / 5 ms は、上の実測を満たすように選んだ値であり、個別の計測は無い

### 副作用とトレードオフ

- 検出が遅れる分だけ相手へ足す遅延が増えるが、足す量は決定 1 の上限 100 ms で抑えられる
- 段差 200 ms 未満の本物のずれは、離れた幅が元へ戻るまで (最大 6 秒) 検出されない。その間に
  相手側の表示の遅れが伸び得る
- 落ち着くまで判定しないため、購読の直後の 3 秒 (動きが続く場合は 10 秒) はドリフトを
  見つけられない

### 再考の条件

- `baseDriftMsPerSecond` が 0 から離れたまま `drift` が続く (受信側は `drift` の間、
  TIMESTAMP を使わず到着基準で再生する)
- `baseDifferenceMs` が単調に増えるのに `drift` にならない (幅 50 ms と確認 6 秒が緩すぎる)
- 逆に、`drift` が一過性の動きで出る (`612b78b` のような誤検出が再発する)
- 購読の直後に `drift` が出て 30 秒戻らない

### 見る計器

- `avSync.delays.baseDriftMsPerSecond` / `avSync.delays.baseDriftLimitMs`
- `avSync.delays.baseDifferenceMs`
- `avSync.delays.unsharedReason`
- `audio.playoutTiming.arrivalPlannedFrames` (基準を共有できない間は到着基準で鳴る)

## 4. 音声の到着基準の遅れと閉ループ

### 決めた値

- `AUDIO_PLAYOUT_DELAY_FLOOR_MS` = 80 ms (到着基準の遅れの下限)
- `AUDIO_PLAYOUT_ARRIVAL_DELAY_MS` = 100 ms (到着基準の遅れの上限。
  `src/audioPlayout.ts` の `AUDIO_PLAYOUT_ARRIVAL_DELAY_SECONDS` と同じ値)
- 閉ループ (`src/audioDelayFeedback.ts`): 下限 `AUDIO_DELAY_FEEDBACK_MIN_MS` = 80 ms、上限
  `AUDIO_DELAY_FEEDBACK_MAX_MS` = 300 ms、初期値 `AUDIO_DELAY_FEEDBACK_START_MS` = 100 ms、
  判断の窓 1 秒、動かす間隔 1 秒、許容 10 ms、余白 20 ms、1 回の増加 20〜40 ms、減らす速さ
  10 ms/秒

### 守っている性質

壁時計の TIMESTAMP を持たない、または基準を共有できない音でも、遅れを 80〜100 ms に収めて
鳴らすこと。音声と映像の基準を共有できないときは、映像をこの「到着 + 到着基準の遅れ」へ
合わせるため、値がずれると A/V のずれが残る。

閉ループは、NetEq の学習が「直近で最も早く届いた音との差」しか見ないため、ストリーム全体が
一様に遅れている分 (復号、予約、出力のバッファ、まとめて届いた山) を補うものである。

### 根拠

- 到着基準の遅れを予約の軸から数えると、出力のバッファの分だけ遅れた。実測では 100 ms の
  目標に対して 195.5 ms 鳴っていた (`src/audioPlayoutSession.ts`)。鳴り始めるまでを
  195.5 ms から 105.6 ms にし、ずれを 50 ms 以内にした (`10f4215`、2026-10-09)
- 予定が無い音は到着基準の 100 ms で鳴らし、316 ms の遅れを無くした (`5096f89`)
- 閉ループの上限 300 ms は、表示の遅れの上限 (500 ms) より小さく、実測の到着の跳ね
  (最大 271 ms) を概ね収める値である (`1a03f71`、2026-10-09)
- 初期値 100 ms は、NetEq の初期値 80 ms より少し大きくし、到着から鳴るまでの経路の分を
  最初から見込む。実測では、揺らぎだけから求めた目標が 40 ms のとき、実際にはその目標より
  遅れて鳴っていた (`src/audioDelayFeedback.ts`)
- 映像を音声の到着基準の時刻へ合わせるようになって、基準を共有できない状態でもずれが
  50 ms 以内になった。合わせないと音声が 195 ms、映像が 98 ms で 100 ms のずれが残っていた
  (`10f4215`)

**根拠が薄い点**:

- 80 ms は libwebrtc の NetEq の初期値 (`AUDIO_DELAY_START_MS`) をそのまま採った値であり、
  この経路で測った値ではない
- 100 ms という上限は「316 ms は遅すぎた」という実測から下げた値であり、80 から 100 の間の
  どこが最適かの計測は無い
- 300 ms は実測の跳ねの最大 271 ms に対して余裕を 30 ms しか取っておらず、これを超える
  跳ねがどれくらいの頻度で起きるかは測っていない

### 副作用とトレードオフ

- 到着基準で並ぶ間、音声は常に到着から 80〜100 ms 遅れて鳴る (ライブ性は落ちる)
- 上限 100 ms を超える学習値は使わない。TIMESTAMP が壁時計からずれているトラックでは、
  ずれそのものを揺らぎとして学習してしまうためである
- 閉ループは `targetLatencyMs` を自動で超えない。`targetLatency` を明示すると、遅れが
  残っていても目標が増えない (devtools では `ceilingMs` が warn 色になる)
- 目標を増やすと、その分だけ映像も一緒に遅れる (基準の遅れとして共有されるため)

### 再考の条件

- `audio.playoutTiming.startDelayMs` の p50 が 100 ms を超える (到着から鳴るまでが長い)
- `audio.playoutTiming.latenessMs` の p50 が許容 (10 ms) を超え続ける、または
  `audio.playoutTiming.missedByReason.backlog` が増え続ける
- `avSync.delays.audioDelayFeedback.appliedMs` が上限 300 ms に張り付く
- `audio.playoutTiming.arrivalPlannedFrames` が増え続ける (時間軸の表示時刻を使えていない)
- `avSync.delays.audioDelayFeedback.adjustments` が増え続ける (目標が収束していない)

見直すときは、`reason` (増やした理由) と `slackP50Ms` / `startDelayP50Ms` を読む。増やす
理由が `lateness` なのか `backlog` なのかで、直す場所が変わる。

### 見る計器

- `audio.playoutTiming.lastTargetMs` / `lastArrivalMs` / `lastStartMs`
- `audio.playoutTiming.slackMs` / `startDelayMs` / `latenessMs`
- `audio.playoutTiming.missedByReason.*` / `recentMisses`
- `audio.playoutTiming.arrivalPlannedFrames` / `unplannedFrames`
- `avSync.delays.audioDelayFeedback.appliedMs` / `targetMs` / `jitterTargetMs` / `reason` /
  `ceilingMs` / `adjustments` / `latenessP50Ms` / `startDelayP50Ms` / `slackP50Ms`
- `audio.playoutRebases` / `audio.playoutDrops`

## 5. 配信側の TIMESTAMP の補正

### 決めた値

- `AUDIO_TIMESTAMP_OFFSET_WINDOW_MS` = 2 秒 (補正に使う観測の窓)
- `AUDIO_TIMESTAMP_OFFSET_MAX_CLOCK_RISE_MS_PER_SECOND` = 100 ms/秒 (時計のずれとして
  追従する上昇の速さの上限)
- `AUDIO_TIMESTAMP_OFFSET_RISE_HOLD_MS` = 5 秒 (速すぎる上昇を採用せずに待つ時間)
- `AUDIO_TIMESTAMP_OFFSET_STEP_MICROS` = 200,000 マイクロ秒 (200 ms。段差とみなす上振れ)
- `AUDIO_TIMESTAMP_OFFSET_STEP_WINDOW_MS` = 500 ms (段差を見る直近の窓)、
  `AUDIO_TIMESTAMP_OFFSET_STEP_MIN_SAMPLES` = 5
- `AUDIO_TIMESTAMP_OFFSET_RISE_CHECK_MS` = 0.5 秒、`AUDIO_TIMESTAMP_SLOPE_WINDOW_MS` = 10 秒、
  `AUDIO_TIMESTAMP_SLOPE_LONG_WINDOW_MS` = 60 秒 (計器の傾き)

### 守っている性質

LOC の TIMESTAMP を「送るサンプルの取得時刻」にすること。`AudioData.timestamp` は
`performance.now()` と同じ時計ではないため、刻みはそのまま使い、原点 (オフセット) だけを
配信側の壁時計へ合わせる。原点は「読み出した壁時計 - `AudioData.timestamp`」の最小値であり、
時計のずれと「撮ってから読むまでの遅れ」の和である。

補正は 3 つの動きに追従する。ゆっくりしたドリフトは窓の最小値が動くのでそのまま採用し、
段差は古い観測を捨てて取り直し、読み出しの遅れが増えただけの動きは水準が続くまで採用しない。

### 根拠

- 速さの上限 100 ms/秒は、実測したドリフトの速さ 20〜50 ms/秒の 2 倍である。これを超える
  上昇は、読み出しの遅れが増えたのであり、音声の時計が動いたのではないとみなす (`1cff6f5`、
  2026-10-10)
- 読み出しの遅れが一瞬増えて戻る場合、そのまま採用すると送る TIMESTAMP が遅れの分だけ動く
  (実測で 95 ms)。受信側はこれを時計のずれとみなして基準の共有を 30 秒解除する。そこで
  5 秒待つ。2 秒の窓が遅れで入れ替わるまでの分 (2 秒) と合わせて、読み出しの遅れが 7 秒
  未満なら補正が動かない長さにする (`1cff6f5`)
- 段差 200 ms は、ドリフトでも「直近の窓の最小値」と「補正の窓の最小値」の差は 100 ms に
  届かないこと、読み出しの遅れが 200 ms 以上ぶれて 0.5 秒続くことは考えにくいことを根拠に
  する。窓の観測が 5 個未満のときは判断しない (たまたま遅れて読めた数個で取り直さない)
- 補正を壁時計へ合わせる設計そのものは 0754 (`cb7a974`、2026-10-09) で入り、一瞬の読み出し
  遅れで動く問題を `1cff6f5` で直した。いったん Revert (`2b44bc8`) された後、実リレーの E2E
  (`809562f`、`tests/e2e/relay/audio-timestamp.spec.ts`) で固定してから戻している

**根拠が薄い点**:

- 窓 2 秒は「音声は 20 ms ごとに読むため約 100 個の観測が入り、読み出しの揺らぎは数 ms で
  最小値はほぼ一定になる」という見積もりであり、窓の長さを変えたときの比較は無い
- 定着 5 秒は「遅れが 7 秒未満なら動かない」という設計上の要請から置いた値であり、
  実際の読み出しの遅れの持続時間の分布は測っていない
- 段差 200 ms と 0.5 秒は「考えにくい」という見積もりである

### 副作用とトレードオフ

- 補正の値は「観測した最大値と最小値の差」の範囲でしか動かない。段差やドリフトの量そのものは
  補正では吸収されず、計器の生の観測に残る
- 待っている 5 秒の間、TIMESTAMP は実際より古いままになる。受信側の再生の目標が過去へ
  ずれて音が捨てられ得る (下がる方向は即座に合わせるため、遅れる側にだけ起きる)
- 配信側だけでは「ずれが残っている」ことは分からない。受信側の基準の遅れと合わせて読む

### 再考の条件

- `slope60sMsPerSecond` が 5 ms/秒から離れたまま戻らない (警告
  `timestampOffsetKeepsMoving`)。実リレーの E2E が「一定のずれ」の上限に使っている値でも
  ある (`tests/e2e/relay/audio-timestamp.spec.ts` の `TIMESTAMP_SLOPE_MAX_MS_PER_SECOND`)
- `appliedMs` が `currentMs` から離れたまま (補正が追随できていない)
- `minMs` と `maxMs` の差が広がり続ける (段差の取り直しが効いていない)
- 受信側で `unsharedReason` が `drift` に固定される

### 見る計器

- `audio.timestampOffset.currentMs` / `minMs` / `maxMs`
- `audio.timestampOffset.slope10sMsPerSecond` / `slope60sMsPerSecond`
- `audio.timestampOffset.appliedMs` / `samples`

## 6. 配信側の追いつき

### 決めた値

- `AUDIO_PUBLISH_CATCH_UP_MIN_MS` = 60 ms (遅れの上限の下限)
- `AUDIO_PUBLISH_CATCH_UP_GROWTH_MS` = 40 ms (健全時の遅れ (床) からさらに許す遅れ)
- `AUDIO_PUBLISH_CATCH_UP_RESUME_MS` = 20 ms (投入を再開する、キューに残ってよい長さ)
- `AUDIO_PUBLISH_CATCH_UP_PENDING_TIMEOUT_MS` = 5 秒 (出力が返らない記録を捨てるまで)
- 方針: `audioCatchUp` の `"drop"` (既定) と `"keep"`

### 守っている性質

音声の符号化が実時間に追いつかなくなったとき、遅れを固定せず live へ戻すこと。映像は
`encodeQueueSize` が上限を超えたフレームを捨てて待ちを伸ばさないが、音声には同じ仕組みが
無い。キューに溜まった分は実時間と同じ速さでしかはけないため、投入を続ける限り遅れは
減らない。捨てる以外に live へ戻る道が無い。

### 根拠

`bb3ccc2` (2026-10-10) で導入した。実測 (実リレーへ同じページから配信と購読を行い、メイン
スレッドを 1 秒止める) は次のとおりである (`src/audioPublishCatchUp.ts` の先頭のコメント)。

- 読み出しの遅れは 0.7 ms のままで、フレームは撮った時刻どおりに読めていた
- 符号化の遅れは 10 ms から 910 ms へ伸び、負荷をやめて 10 秒たっても 910 ms のまま
  戻らなかった
- 受信側の音声の基準の遅れは 19 ms から 919 ms へ伸びた (映像は 12 ms のまま)

値の根拠は次のとおり。

- 上限を床からの増加で測るのは、健全時の遅れが環境で決まるためである (実測: 手元の 1 台では
  11 ms、4 vCPU の runner では 30〜190 ms)。絶対値で測ると、遅い環境では健全な状態でも
  捨て続けることになる
- 40 ms の成長分は、負荷で 100 ms 前後へ伸びた遅れを 1 秒未満で床へ戻せた値である
- 60 ms の下限は、音声の 1 パケット 20 ms の 3 パケット分である。符号化の出力が返るまでに
  少なくとも 1 パケットはキューに残るため、健全な状態でも 10〜20 ms の遅れがある
- 再開を 1 パケット (20 ms) 以下まで待つのは実測からである。上限 (60 ms) と 40 ms の間で
  往復させたところ、投入が出力のたびに 1 フレームだけになり、出力が入力の半分ずつ減って
  (opus の 1 パケットは 20 ms の入力が要る) 音声がほとんど送られなくなった
- 出力の timestamp ではなく「覆った最初の投入の timestamp」を使うのは、`AudioEncoder` が
  出力の timestamp を符号化したサンプル数から作るためである。フレームを捨てて投入に穴が
  空くと、出力の timestamp は投入より古くなる (実測)

その後の実測 (2026-10-10、CI の runner で音声の基準の遅れが 116 ms から 836 ms へ伸びた
run 38026081292 の切り分け) で、遅れが溜まる段は配信側ではなかった。符号化の出力が返るまでの
待ち (`pendingMs`) と送信のキュー (`sendQueueMs`)、撮ってから送信が終わるまでの遅れ
(`sendLagMs`) はどちらも 20 ms 前後で動かず、受信側が Object を受け取るまでの遅れ
(`receiveDelayMs`) も 20〜30 ms のままだった。残る段は受信側の復号と再生であり、原因は
決定 8 (復号の出力と投入の対応づけ) だった。配信側の計器は、この切り分けのために足した。

**根拠が薄い点**:

- 60 ms という下限そのものは「3 パケット分」という丸めであり、健全な環境での遅れの分布
  (手元 11 ms、runner 30〜190 ms) から決めた値ではない
- `sendQueueMs` / `sendLagMs` は健全な状態 (手元の再現で 0〜20 ms / 10〜20 ms) しか測って
  おらず、送信が実際に詰まる条件 (回線の帯域、relay の stream の上限) での値は無い
- 5 秒の保留の破棄は「これを超える遅れは追いつきの対象であり、記録を残す意味が無い」という
  見積もりである
- 「keep」を選ぶべき条件 (間引くと壊れる内容かどうか) は測って決められるものではなく、
  用途の判断である

### 副作用とトレードオフ

- `"drop"` の間は音が欠ける (1 回の追いつきで 3 パケット以上)。欠けた区間は opus の
  concealment が埋めるため、遅れたまま送り続けるより聴感は良いという判断である
- `"keep"` は捨てない代わりに遅れが固定される。受信側は遅れたまま鳴らし続ける
- 上限は環境ごとの床で決まるため、環境が悪化したままになると床そのものが上がり、追いつきが
  始まらない状態があり得る (そのための絶対値の下限が 60 ms である)

### 再考の条件

- 1 分に 3 回以上、追いつきが始まる (警告 `catchUpKeepsStarting`)。1 回で 60 ms なら
  3 パケット、1 分に 3 回なら 9 パケットの音が欠ける
- `droppedMs` が増え続ける、または `maxLagMs` が上限に対して大きすぎる
- `floorMs` が環境の悪化に合わせて上がり、遅れが固定される (`lagMs` が `floorMs` の近くで
  動かない)
- 受信側の `avSync.delays.audio.baseDelayMs` が配信側の `audio.catchUp.lagMs` と一緒に増える

見直すときは、閾値より先に「なぜ符号化が実時間に追いつかないのか」(解像度、ビットレート、
worker の使い方) を見る。追いつきは症状を消すだけで、原因は消さない。

### 見る計器

- `audio.catchUp.policy` / `catchUpStarts` / `catchingUp`
- `audio.catchUp.lagMs` / `floorMs` / `maxLagMs` / `readLagMs` / `pendingMs` / `pendingFrames`
- `audio.catchUp.sendQueueMs` / `sendQueueFrames` / `sendLagMs` / `maxSendLagMs`
- `audio.catchUp.droppedFrames` / `droppedMs`
- `audio.chunksEncoded` / `audio.encodeErrors`
- `publishTiming.encodeMs` (符号化の待ち時間)

## 7. 受信側の再生の組み立て

### 決めた値

- 音声は `AudioPlayoutSession` (`src/audioPlayoutSession.ts`)、映像は `VideoPlayoutSession`
  (`src/videoPlayoutSession.ts`) に組み立てを集約する
- ライブラリ (`createMediaSubscriber`) と moqt-devtools の両方が同じ実装を使う

### 守っている性質

同じ組み立てを 2 か所に持たないこと。到着基準の遅れ、閉ループ、計器の修正を 2 か所へ
入れる必要があり、片方だけを直すと挙動がずれる。実際に devtools とライブラリで二重実装に
なっていた (`8d4ce11`、2026-10-09)。

ブラウザ依存 (Web Audio の `AudioContext` とその時計、`requestAnimationFrame`、出力先) は
注入する境界に閉じ込める。ブラウザ API の無い環境でも記録用の最小オブジェクトを注入すれば
検証できる。

### 根拠

- `d41b8a4` (音声の組み立てを切り出す) → `5eecbe8` (ライブラリ) → `739cb52` (devtools) →
  `26fbf66` (文書化) の順で、共有実装へ載せ替えた。映像も `31e8539` → `36370e3` →
  `75c7e89` → `6f1ddc5` と同じ順である
- 共有実装の外で起きた失敗も `onError` へ通知する (`5187744`)。組み立てを共有すると、
  呼び出し側の失敗が黙って落ちる経路ができるためである
- 2026-10-10 に映像の表示の組み立てを共有実装へ寄せた (`028da5d`)

**根拠が薄い点**: 値ではなく構造の決定であり、根拠は「二重実装で片方だけ直す事故が起きた」
という事実である。性能や挙動の比較は無い。

### 副作用とトレードオフ

- 呼び出し側が持つ判断 (relay の cache から追いつく途中の音を鳴らさない、再生の有効と無効、
  音声だけの購読、購読ごとの統計と画面への反映) は共有実装の外に残る。ここが食い違うと
  ライブラリと devtools で挙動が変わる
- 注入する境界の型 (`AudioPlayoutOutput` / `VideoPlayoutOutput`) が増える

### 再考の条件

- ライブラリと devtools で再生の判断 (鳴らすかどうか、いつ描くか) が再び分かれたとき
- 共有実装の外に置いた判断が、計器に出ない形でずれを生んでいるとき
  (`audio.playoutTiming.unplannedFrames` が 0 でない、`audio.playoutTiming` の値と
  `audio.objectsReceived` / `audio.chunksDecoded` が合わない)

### 見る計器

- `avSync.*` (時間軸の推定)
- `audio.playoutTiming.*` (鳴らした結果)
- `playbackTiming.*` (表示の結果)

## 8. 復号の出力と投入の対応づけ

### 決めた値

- `DECODER_OUTPUT_TIMESTAMP_TOLERANCE_MICROS` = 1,000 マイクロ秒 (復号の出力の timestamp と、
  復号へ渡した timestamp の差として許す上限。`src/decodeInputTimestamps.ts`)

### 守っている性質

復号の出力 (`AudioData`) が、復号へ渡した音の TIMESTAMP の種類 (壁時計かメディア時刻か) を
保つこと。`AudioData` は種類を持たないため、復号へ渡した時に覚えて出力で引く。種類を失うと、
その音は共有の時間軸へ記録されず、音声の基準の遅れが更新されない。A/V 同期は更新されない値の
まま比較を続け、映像の表示を誤った相手へ合わせる (遅れている側を基準にしない)。

### 根拠

実リレー (Opus、48 kHz) の実測で、`AudioDecoder` の出力の `AudioData.timestamp` は復号へ
渡した timestamp より 100 マイクロ秒だけ大きかった。完全一致で引いていたため、購読を始めて
1 秒ほどで引けなくなり、復号へ渡した記録が 1 秒に約 50 件増え続けた (実測。記録の上限まで
増え続け、対応づけは回復しない)。

CI の runner (run 38026081292) では、音声の基準の遅れが 116.3 ms のまま 9 秒間更新されず、
次に一致した観測で 630.8 ms、さらに 836.2 ms へ飛び、A/V の基準の共有が解除された
(`unsharedReason` が difference、drift)。同じ観測で映像の基準の遅れは 112.6 ms のまま安定し、
配信側の原点の傾きも 0 だった。更新されない値と、たまに一致した観測の値とが入れ替わる形は、
この症状 (基準が凍り、飛ぶ) と一致する。

手元の再現 (実リレーへ配信と購読を同じページから行い、Chromium の CPU を 4 倍に遅くする) では、
修正前に音声の基準の遅れが 22 ms から 160 ms へ伸び続け、復号へ渡したまま出力が返っていない
記録が 1 秒に約 50 件増え続けた。修正後は 30 秒間 20 ms 前後で動かず (3 等分した中央値で
20.4 ms / 19.8 ms / 20.6 ms)、記録は 1 件のままになった。

**根拠が薄い点**: 100 マイクロ秒は 1 つの実装 (Chromium の Opus) の実測であり、他の codec
(AAC) や他の実装で同じ大きさになるかは測っていない。1 ms という許容は「Opus の最短フレーム
(2.5 ms) の半分未満」という見積もりで置いた値であり、ずれの分布を測ったものではない。

### 副作用とトレードオフ

- 1 ms 以内のずれは同じ音とみなすため、隣り合う音の間隔が 2 ms 未満の用途では取り違え得る
  (Opus の最短フレームは 2.5 ms であり、想定していない)
- 引けなかった記録は、1 ms より古くなった時点で捨てる。出力が入力と対応しないまま続くと、
  その分の位置 (relay の cache から追いつく途中かどうか) は分からなくなり、従来どおり
  鳴らす側へ倒れる

### 再考の条件

- `audio.playoutTiming.arrivalPlannedFrames` が増え続ける (種類を引けていない)
- `avSync.delays.audio.baseDelayMs` が同じ値のまま動かない (更新されていない)
- 出力の timestamp のずれが 1 ms に近づく codec が現れる

### 見る計器

- `audio.playoutTiming.arrivalPlannedFrames` / `unplannedFrames`
- `avSync.delays.audio.baseDelayMs`
- `audio.receiveDelayMs` (受信した壁時計 - LOC TIMESTAMP。配信側の
  `audio.catchUp.sendLagMs` と対で読み、遅れが配信側と経路にあるのか受信側にあるのかを分ける)

## 実行時の警告 (前提から外れた状態)

上の「再考の条件」のうち、既にある計器の値だけで判定できるものを moqt-devtools が出す。
新しい計測は行わない。判定は 1 秒ごとに行い、Subscriber の `A/V Sync` と Publisher の
`Audio` の `Warnings` セクション、「Copy for LLM」の `warnings` に出る。警告になった時点と
戻った時点はデバッグログに 1 件だけ残す (毎秒出ると、症状が出たときにログから追えない)。

| 警告                          | 出す条件                                                                                     | 閾値の根拠                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncExtraDelayPinnedAtLimit` | `sharingBases` が true で、`syncExtraDelayMs` が上限の 5 ms 以内のまま 10 秒続く             | 上限に達すると足す量は上限そのものになり、観測の間隔 (映像で 33 ms) では毎秒 20 ms の減衰も効かない。張り付いた分が戻り切る時間 (100 ms ÷ 20 ms/秒 = 5 秒) の 2 倍を「戻らない」とみなす |
| `unsharedHoldContinues`       | `unsharedReason` が `hold` のまま 20 秒続く                                                  | 早期解除は差が戻れば 2 秒で済む。続くのは差が戻っていないか、閾値だけが動いた解除が繰り返されているかである。保持の満了 (30 秒) を待たずに 2/3 で出す                                    |
| `timestampOffsetKeepsMoving`  | 観測が 500 個以上あり、`slope60sMsPerSecond` (無ければ `slope10sMsPerSecond`) が 5 ms/秒以上 | 実リレーの E2E が「一定のずれ」の上限に使っている値 (実測は 0.0 ms/秒、ずれる場合は 20 ms/秒 を超える)。観測 500 個は 10 秒分 (音声を 20 ms ごとに読む) である                           |
| `catchUpKeepsStarting`        | 60 秒の窓の中で `catchUpStarts` が 3 以上増える                                              | 1 回の追いつきで 60 ms (3 パケット) 以上を捨てる。1 分に 3 回なら 9 パケットの音が欠け、音声は実時間で符号化できるという前提が崩れている                                                 |

## 再考の手順

症状が出たとき、または節目 (リリース前、A/V 同期まわりの変更の後) に、次の順で行う。CI で
実リレーの E2E を直したときに使った流れ (実測 → 判定 → 実装を直す) をそのまま再利用する。

### 1. 実測する

実リレーへ同じページから配信と購読を行い、devtools の統計を取る (`tests/e2e/relay/` の spec と
同じ条件)。1 秒ごとに 25 秒以上観測し、「Copy for LLM」の本文をそのまま残す。観測を始める
前に、基準の遅れが 3 秒動かなくなるのを待つ (`READY_SETTLED_MS`。待たずに始めると、購読の
直後の過渡を動きとして数えてしまう)。

測るのは次の 4 指標である。

| 指標             | 見る値                                                                                                                                                      | 何が分かるか                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 同期             | `avSync.delays.*.syncExtraDelayMs`、`avSync.delays.baseDifferenceMs`、`avSync.delays.unsharedReason`、`avSync.delays.baseDriftMsPerSecond`、`avSync.skewMs` | 合わせられているか、上限に張り付いていないか、基準を共有できているか      |
| 音声の再生       | `audio.playoutTiming.slackMs` / `startDelayMs` / `latenessMs`、`missedByReason`、`arrivalPlannedFrames`、`avSync.delays.audioDelayFeedback.*`               | 80〜100 ms で鳴っているか、目標が収束しているか、到着基準へ落ちていないか |
| 配信側の補正     | `audio.timestampOffset.slope10sMsPerSecond` / `slope60sMsPerSecond` / `appliedMs` / `minMs` / `maxMs`                                                       | TIMESTAMP が壁時計からずれていないか                                      |
| 配信側の追いつき | `audio.catchUp.catchUpStarts` / `catchingUp` / `lagMs` / `floorMs` / `droppedMs`                                                                            | 実時間で符号化できているか                                                |

### 2. 判定する

devtools の `Warnings` と上の 4 指標を、この文書の各決定の「再考の条件」に突き合わせる。
警告が出ていれば、その警告の `values` が示す計器を見る。警告が出ていなくても、値が単調に
動いていれば前提から外れかけている。

### 3. 前提を切り分ける

どの前提が外れているかで直す場所が変わる。

- 時計のずれ (差が動き続ける、配信側の傾きが 0 から離れる) → 決定 3 と 5
- 経路の遅れ (差は動かないが大きい、跳ねが大きい) → 決定 1、4
- 実時間に間に合っていない (追いつき、符号化の遅れ) → 決定 6
- 組み立てのずれ (ライブラリと devtools で違う、到着基準へ落ちる) → 決定 7

### 4. 実装を直す

閾値を動かす前に、その閾値が守っている性質 (この文書の「守っている性質」と「副作用と
トレードオフ」) を確かめる。値の変更と、この文書の「値」「根拠」「再考の条件」の更新は
同じコミットで行う。

### 5. 実測で確かめる

実リレーの E2E は「実装が保証する不変条件」で判定する。絶対値を判定にすると、runner の
処理能力を測ることになるためである。観測値そのものは失敗時の切り分けのために
メッセージへ残す (`tests/e2e/relay/audio-timestamp.spec.ts`)。

## 出典

| コミット                 | 日付       | 内容                                                                            |
| ------------------------ | ---------- | ------------------------------------------------------------------------------- |
| `9314980`                | 2026-10-09 | 音声と映像の基準がずれ続けたら同期をやめ、足した遅延を戻す (ドリフト検出の初出) |
| `690d51b`                | 2026-10-09 | 音声と映像の遅延の内訳を出して解析できるようにする                              |
| `f13db71`                | 2026-10-09 | A/V 同期が時計のずれを相手側の遅延へ移すのを止める (上限 100 ms と保持 30 秒)   |
| `711a33f`                | 2026-10-09 | 音声の再生の計器を devtools とライブラリに追加                                  |
| `5096f89`                | 2026-10-09 | 音声が信用できない TIMESTAMP に引きずられて遅れるのを直す                       |
| `176a433`                | 2026-10-09 | 映像を膨らんだ音声の遅延に合わせず、音声も跳ばさない                            |
| `10f4215`                | 2026-10-09 | 音声の到着基準の遅れを実際に鳴る位置から数え、映像をその時刻へ合わせる          |
| `cb7a974`                | 2026-10-09 | 送る音声の TIMESTAMP を配信側の壁時計から作る                                   |
| `809562f`                | 2026-10-09 | 音声の TIMESTAMP のずれを実リレーの E2E で固定する                              |
| `1a03f71`                | 2026-10-09 | 音声の jitter buffer の目標を実際の遅れから閉ループで決める                     |
| `d41b8a4` から `6f1ddc5` | 2026-10-09 | 音声と映像の再生の組み立てを共有実装へ切り出す                                  |
| `bb3ccc2`                | 2026-10-10 | 配信側の音声が遅れたら古いフレームを捨てて live へ追いつく                      |
| `612b78b`                | 2026-10-10 | 受信側が一過性の基準の差の動きを時計のずれと誤判定するのを修正する              |
| `1cff6f5`                | 2026-10-10 | 配信側の音声の TIMESTAMP が一瞬の読み出し遅れで動くのを修正する                 |
| `c3e00bf`                | 2026-10-10 | 受信側が基準の共有を解除した後、差が戻ったら保持を待たずに戻す                  |
| `028da5d`                | 2026-10-10 | 映像の表示の組み立てを共有実装へ寄せる                                          |
