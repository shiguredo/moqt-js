# 受信音声の playout が無音の穴をフェードなしで出力し、クリックとして聞こえる

- Created: 2026-10-20
- Completed: 2026-10-20
- Branch: feature/fix-playout-silence-gap-click
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

利用者から「moqt-js の playout でプチプチノイズが出る」との報告があり、実リレー経由の
購読音声を波形として収録したところ、次の穴と段差を確認した。前提は Opus (48 kHz) +
Datagram (moqt-devtools の既定。冗長度 2) であり、復号の出力は 20 ms のフレームである。

- 60.74 秒の収録に、デジタル無音 (ビット完全な 0) の区間が 36 個、合計 149.0 ms、最長
  22.5 ms 入っていた
- その両端に、トーンの peak (0.305) と同程度の硬い段差が 90 件あった。位相の飛びは 0 件で、
  波形を継ぎはぎしたのではなく、鳴っている途中に 0 が挿入される形である
- 同時刻の計器は `playoutDrops` 0、`missedFrames` 0、`playoutConcealedMs` 66 ms であり、
  この穴を 1 つも数えていない。そのため 2026-10-16 の計測ではノイズを検出できなかった

穴を埋め、境界の段差を消し、再発を計器で検出できるようにする。

## 現状

- `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.concealmentOf` は、隙間が
  `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS` (5 ms) 以下のときと、前の音の終わりが
  `nowSeconds + minLeadSeconds` より前のときに補間を返さない。実リレーで検出した無音区間
  36 個のうち、前者が 27 個 (62.9 ms)、後者 (アンダーラン) が 9 個 (合計 86.2 ms、
  5.8〜22.5 ms) である。これとは別に検出下限未満の微小な無音が 9 個 (約 10 ms) ある。
  90 件の不連続の内訳は、36 個の両端のうち 71 件 (先頭の開始端は収録の外)、微小な無音
  9 個 × 2 端 = 18 件、開始前の過渡 1 件である
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.startBuffer` は、
  `createBuffer` と `copyToChannel` でサンプルを詰めて `start(whenSeconds)` するだけで、
  バッファ境界のフェードもクロスフェードも行わない。補間しなかった隙間の前後は、440 Hz の
  トーンで振幅の 60〜100 % の段差になる
- `src/playout/audioPlayoutTimingStats.ts` の `AudioPlayoutTimingSnapshot` は、鳴らさなかった
  音 (`backlog` / `catchUp` / `error` / `stopped`) だけを数える。鳴ったが無音だった区間、
  境界の段差、予約の重なり、予約判断の後に `AudioContext.currentTime` が予約時刻を
  追い越した回数を持たない
- アンダーランは到着の揺らぎが目標遅延を超えることで起きる。実測の到着列の揺らぎは
  p50 2.21 / p95 73.6 / p99 92.3 / 最大 110.5 ms であり、目標遅延は 80〜100 ms である。
  本番モジュールを直接駆動した再現では、目標の深さ 86 ms で 60 秒に 24 回 / 162 ms、
  120.5 ms で 0 回になった (鳴り始めは +35 ms。適応の上限 160 ms の内側)
- 損失や復号器の作り直しで media 時刻が飛ぶと、`AudioPlayoutScheduler.schedule` は次の音を
  前の音の終わりに置くため、隙間 0 のまま内容だけが飛ぶ。この境界にもフェードは無い。
  合成信号での解析値は、440 Hz のトーンで 20 ms 飛びが peak の 113 %、40 ms が 188 %、
  80 ms が 122 % の段差になる
- Datagram は再送されないため、20 ms のフレームが 1 つ落ちると復号の出力が 1 つ欠ける。
  WebCodecs の `AudioDecoder` には損失を通知する手段 (PLC) が無いため、補間で埋めるしか
  ない。冗長度 2 の 2 回目が届けば救われるが、2 回目は遅れて届くため到着順が入れ替わる。
  Datagram の到着順は保証されず、受信側は音声を到着順に復号へ渡すため、timestamp の順と
  逆に届くと隙間 0 のまま内容だけが逆順に鳴る
- 予約判断の後、`compressSamples`、補間バッファ生成、`createBuffer`、`start` の間に
  `currentTime` が `startAt` を追い越すと、Web Audio は即時開始にして前のバッファと重なる。
  `createBuffer` の中で時計を 12 ms 進めると、600 フレーム中 22 回、41 ms の重なりが再現する。
  実機の long-task 記録は無く、実リレーでは発生していない

## 設計方針

- 計器を足す。穴の回数、合計 ms、最大 ms、予約できなかった穴の合計、境界の段差、予約の遅れ
  と重なりを `AudioPlayoutTimingSnapshot` と `AudioStats` へ足し、E2E の判定と devtools の
  表示に載せる。値を「鳴らした音の長さ」に対する割合で読める形にする
- 予約できる隙間を埋める。5 ms の下限を下げ、補間が失敗する音では、隙間の長さに合わせた
  短いフェード (前の音の末尾を 0 へ、0 から次の音の先頭へ) で埋める。補間の継ぎ目が耳に
  つく音では、無音より短いフェードの方がよい
- 全バッファ境界に一律のフェードを入れない。20 ms 周期の振幅変調になり、440 Hz で 50 Hz
  間隔の側波帯が −26 dBc 立つ
- 予約できないアンダーランは事後には埋められない。`src/playout/audioDelayFeedback.ts` の
  閉ループへ穴の発生を入力し、圧縮だけでなく穴でも目標遅延を上げる。戻す条件は既存の
  規則と同じ速さにする
- media 時刻の飛びは、1 フレーム先読みして飛びを検出した境界の前後にフェードを掛ける
  (配信側の `src/audioSpliceFade.ts` と同じ考え方)。先読みの 20 ms は遅延に加算されるため、
  計器で効果を測ってから採否を決める
- 予約直前に `context.currentTime` を取り直し、`whenSeconds` が過去なら
  `currentTime + 余裕` へ押し直す。押し直した分は次の音との間の穴になるため、フェードと
  併用する

## 完了条件

- 実リレー 60 秒の波形収録で、デジタル無音と境界の段差が計器に出ること。計器は購読開始から
  の累積で波形は収録区間のため厳密な一致は求めず、境界の段差の件数が波形の不連続と同程度
  (同じ桁) であることをもって一致とみなす
- 5 ms 以下の隙間のうち予約できるものが無音でなくなること (合成信号の単体テスト)
- 予約できないアンダーランがベースラインより減ること。実測の到着列で 24 回から 12 回、
  実リレーの負荷時に 18 回から 9 回まで減ること (残る分は目標遅延と遅延の取引として別途判断)
- Datagram の損失を注入したときの穴の量が計器に出ること (実リレーの調査 spec または
  単体テスト)
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

media 時刻の飛びの両側フェードと、予約時刻の押し直しは、効果と遅延の取引を測る必要がある
ため対象外とし、`issues/0871-bug-playout-media-jump-and-late-start.md` に分けた。

## 解決方法

- 計器: `AudioPlayoutTimingSnapshot` に、補間で埋まらなかった穴 (`gapCount` / `gapMs` /
  `gapMaxMs`)、予約できる最も早い時刻 (今 + 余裕) より前だった穴
  (`unrecoverableGapCount` / `unrecoverableGapMs`。既に過去の分と、未来でも余裕に満たない
  分を含む)、予約の追い越し (`lateStartCount` / `lateStartMaxMs`)、バッファ境界の段差
  (`boundaryStepCount` / `boundaryStepMax`、しきい値
  `AUDIO_PLAYOUT_BOUNDARY_STEP_THRESHOLD` = 0.05) を足した。`AudioReceiverStats.playoutTiming`
  と devtools の Audio Playback Timing から読める。段差は実際に鳴るサンプルで測るため、
  フェードで消えた段差は数えない
- 穴埋め: `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS` を 5 ms から 0.5 ms へ下げ、予約できる隙間を
  補間で埋めるようにした。0.5 ms 以下の隙間は `AudioPlayoutScheduler.snapToPreviousEnd` で
  前の音の終わりに揃え、1〜2 サンプルのデジタル無音を作らない。揃えられないとき (前の音の
  終わりが今より過去のとき) は無音として計器に出して先頭をフェードする。前の音の終わりが
  今 + 余裕より前でも未来の分は補間し (`unrecoverableGapSeconds`)、補間の末尾と直後の
  音声の先頭を 2 ms でフェードする。穴が無い境界と最初の音にはフェードを入れない
- 適応: 穴の累積を `AudioDelayFeedbackObservation` へ渡し、穴が空いたら `reason: "gap"` で
  目標遅延を上げる。時間圧縮と同じく artifact ceiling (100 → 160 ms) の拡張条件に穴を
  加え、戻す条件に穴 0 を加えた。最後の穴から 5 秒間は目標を下げないホールド
  (`AUDIO_DELAY_FEEDBACK_GAP_QUIET_MS`) を入れた
- 実リレーの検証 (Opus + Datagram、60 秒収録): デジタル無音 36 個 / 149.0 ms / 段差 90 件
  (develop、load 3.0) から、8 個 / 39.9 ms / 段差 10 件 (実装後、load 10.7) へ減った。
  計器は `gapCount` 21 / `gapMs` 73.3 ms / 予約不能 9 / 57.5 ms / `boundaryStepCount` 10 で、
  波形の段差 10 件と一致した。`lateStartCount` は 0。実リレーの E2E も通る
- 計器の読み方: `gapCount` / `gapMs` は購読開始からの累積であり、波形の無音は収録区間
  (60.74 秒) の値であるため一致しない (収録前後の穴は計器だけに含まれる。実測: `gapMs`
  73.3 ms に対し波形の無音 39.9 ms)。完了条件の「波形と一致」は、同じ収録区間の境界の
  段差が一致すること (`boundaryStepCount` 10 = 波形の不連続 10) と、穴の量が同じ桁に
  収まることで判定した
- レビューでの修正: 補間の生成長の丸め (半サンプル以内) を穴として数えていたため、
  半サンプルを超える差だけを穴として数えるようにした。補間が完全に成功した隙間のうち、
  丸めで誤って穴として数えていた分 (約半数) が数えられなくなる。前の音の終わりが今より
  過去で揃えられない 0.5 ms 以下の隙間は、無音として計器に出して先頭をフェードするように
  した。この修正後の実リレーの再計測は未了である (上の実測値は修正前の実装による)
- 設計方針にあった「鳴らした音の長さに対する割合」は、専用のフィールドを足さず
  `playedMs` と併記して読む形にした (累積の定義を増やすと意味が二重になるため)
- 対象外として分けたもの: media 時刻が飛ぶ境界の両側フェードと、予約時刻の押し直しは
  `issues/0871-bug-playout-media-jump-and-late-start.md` で扱う

## 参照

- 調査記録: `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`、`docs/AUDIO_PLAYOUT_RESULT.md`、
  `docs/AV_SYNC_DECISIONS.md` §13
- `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` / `concealmentOf` /
  `concealmentEndGain` / `AUDIO_PLAYOUT_MIN_CONCEAL_SECONDS`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.handleDecodedAudio` /
  `startBuffer` / `AudioPlayoutSession.recordStopped`
- `src/playout/audioPlayoutTimingStats.ts` の `AudioPlayoutTimingStats.recordPlay` /
  `recordMiss` / `snapshot`
- `src/playout/audioTimeStretch.ts` の `compressSamples` / `concealSamples`
- `src/playout/audioDelayFeedback.ts` の `AudioDelayFeedback.update`
- `src/codec/types.ts` の `AudioStats` / `AudioReceiverStats`
- `tests/e2e/relay/investigation-audio-output.spec.ts` (調査用。`MOQT_INVESTIGATION=1` で動く)
