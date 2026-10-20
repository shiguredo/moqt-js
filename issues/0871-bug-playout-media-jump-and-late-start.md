# 音声 playout の media 時刻飛びと予約の追い越しを、フェードと予約時刻の押し直しで直す

- Created: 2026-10-20
- Completed: 2026-10-20
- Branch: feature/fix-playout-media-jump-and-late-start
- Polished: {YYYY-MM-DD}
- Reporter: @voluntas

## 目的

受信 playout の無音の穴によるクリックは、補間と境界フェード、目標遅延の適応で大きく減った。
しかし次の 2 つの保護が残っている。

- 損失や復号器の作り直しで media 時刻が飛ぶ境界 (隙間 0 のまま内容だけが飛ぶ) は、両側の
  フェードが無い。実リレーの収録でも `boundaryStepCount` に 1 件出た
- `AudioBufferSourceNode.start(when)` の時点で `when` が `AudioContext.currentTime` より
  過去だと、Web Audio は即時開始にして直前の音と重なり得る。計器 (`lateStartCount`) は
  足したが、押し直しはしていない。実リレーでは 0 件だったが、メインスレッドが止まった
  ときに起きる

両方を直し、実リレーで段差と重なりが残らないことを確かめる。

## 現状

- `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` は、隙間 0 の media
  時刻の飛びを検出しない。前の音の終わりに次の音を置くだけであり、波形は不連続になる。
  `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.playSound` は、隙間がある
  場合だけフェードするため、隙間 0 の飛びにはフェードが入らない
- `AudioPlayoutSession.startBuffer` は、`source.start(when)` の直前に
  `AudioContext.currentTime` を読んで `lateStartCount` に記録するだけで、押し直さない
- 合成信号の再現では、`createBuffer` の中で時計を 12 ms 進めると、600 フレーム中 11〜22 回
  `lateStart` になり、13 回 / 18.5 ms の重なりが出る。実機の long-task 記録は無く、
  実リレーでは 0 件である
- media 時刻の飛びの解析値は、440 Hz のトーンで 20 ms 飛びが peak の 113 %、40 ms が
  188 %、80 ms が 122 % の段差になる

## 設計方針

- 音声バッファを 1 フレーム先読みして保持し、次の復号出力の timestamp が前の timestamp と
  フレーム長から期待される間隔を超えて飛んだとき、保持しているバッファの末尾 2 ms を
  フェードアウトし、次のバッファの先頭 2 ms をフェードインする。配信側の
  `src/audioSpliceFade.ts` と同じ考え方である
- 先読みの 1 フレーム (Opus で 20 ms) は遅延に加算される。実リレーの A/V 同期と鳴り始めの
  遅れ、`boundaryStepCount` の減少を測り、効果が遅延の代償を上回るかで採否を決める
- `AudioPlayoutSession.startBuffer` で、`source.start(when)` の直前に
  `AudioContext.currentTime` を取り直し、`when` が `currentTime + 余裕` より過去なら
  その時刻へ押し直す。余裕はレンダリング量子 (128 フレーム = 約 2.7 ms) を踏まえた 3 ms
  とし、予約判断の下限 (10 ms) とは分ける。押し直した音は先頭 2 ms をフェードインし、
  押し直した分だけ次の音を後ろへずらす (`AudioPlayoutScheduler.shiftPlayoutEnd`)
- 押し直しで重なりが無くなったことを、`lateStartCount` (意味は変えない) と、次の音が
  押し直した音の終わりから並ぶことの単体テストで確かめる

## 完了条件

- 合成信号で 12 ms の停止を与えたとき、予約の追い越しによる重なりが 0 になること
  (単体テスト)
- 押し直しを入れた場合、実リレーの A/V 同期 (`skewMs`)、鳴り始めの遅れ (E2E の 200 ms
  未満)、既存の E2E 判定に回帰が無いこと
- media 時刻の飛びの両側フェードは、1 フレーム先読みの +20 ms の効果を計測して採否を
  決め、採らない場合は理由と再検討条件を docs に残すこと (実測: 60 秒で 1 件・段差は
  peak の 56 %、代償は全音声 +20 ms のため見送り)
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

## 解決方法

- 押し直し: `AudioPlayoutSession.startBuffer` が `createBuffer` と `createBufferSource` の
  後に `currentTime` を取り直し、`whenSeconds < currentTime +
  AUDIO_PLAYOUT_PUSH_START_LEAD_SECONDS` (3 ms) ならその時刻へ押し直して `start()` する。
  押し直した音は先頭 2 ms をフェードインし、押し直した分だけ
  `AudioPlayoutScheduler.shiftPlayoutEnd` で次の音を後ろへずらす。押し直しの境界はフェード
  したため `boundaryStepCount` に数えない。`recordPlay` / `recordPresentation` は実際の
  開始時刻を使う。`lateStartCount` / `lateStartMaxMs` の意味 (予約時刻を currentTime が
  追い越した回数と長さ) は変えていない
- media 飛びの両側フェードの計測: 実リレーの実装後収録 (61.1 秒、load 10.7) の不連続 10 件は
  無音の穴の開始 9 件と media 飛び 1 件であり、media 飛びの段差は 0.171 (peak の 56 %)、
  原因は catchUp の復号器作り直し (missedFrames 1 / 20 ms) だった。1 フレーム先読みの
  両側フェードで消えるのはこの 1 件だけで、代償は全音声 +20 ms (startDelay p50 134 → 154 ms、
  E2E の長時間 155.5 → 175.5 ms、A/V skew −3.8 → −23.8 ms) になる。E2E の上限 200 ms への
  余裕が半分以下になるため見送り、段差は `boundaryStepCount` で監視する。再検討条件は
  media 飛びが 60 秒で 3 件以上、startDelay の上限への余裕が 40 ms 以上、遅延予算を
  +20 ms 宣言できる場合
- 実リレーの検証: 負荷の低い時間帯 (load average 2 前後) の 60.7 秒収録で、デジタル無音
  0 件・サンプル不連続 0 件、`gapCount` 1 / 20 ms (予約不能 0)、`boundaryStepCount` 1 /
  0.108、`lateStartCount` 0 (`lateStartMaxMs` 0)、鳴り始め p50 65.3 ms、A/V のずれ
  −9.2 ms だった。全 E2E は 23 件成功 (skip 11)。`vp check` / `tsc --noEmit` /
  `vp test run` (234 ファイル / 4142 テスト) も成功

## 参照

- 調査記録: `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` (media 時刻の飛び、予約の追い越し)、
  `docs/HIGH_LEVEL_API.md` (`boundaryStepCount` / `lateStartCount` の説明)
- `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` / `snapToPreviousEnd`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.playSound` / `startBuffer`
- `src/playout/audioPlayoutTimingStats.ts` の `recordBoundaryStep` / `recordLateStart`
- `src/audioSpliceFade.ts` の `fadeSpliceEdge`
- `tests/e2e/relay/investigation-audio-output.spec.ts` (調査用。`MOQT_INVESTIGATION=1` で動く)
