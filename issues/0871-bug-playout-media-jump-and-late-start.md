# 音声 playout の media 時刻飛びと予約の追い越しを、フェードと予約時刻の押し直しで直す

- Created: 2026-10-20
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-playout-media-jump-and-late-start
- Polished: {YYYY-MM-DD}

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
  その時刻へ押し直す。押し直した分は次の音との間の穴になるため、穴の計器とフェードを
  併用し、押し直した回数と長さを計器に残す
- 押し直しで重なりが無くなったことを、`lateStartCount` と重なりの計器 (新設するか、
  既存の境界段差で代替する) で確かめる

## 完了条件

- media 時刻の飛びの境界の段差が、実リレーの収録で `boundaryStepCount` に出なくなる、
  または半減すること
- 合成信号で 12 ms の停止を与えたとき、予約の追い越しによる重なりが 0 になること
  (単体テスト)
- 先読みを入れた場合、実リレーの A/V 同期 (`skewMs`)、鳴り始めの遅れ (E2E の 200 ms 未満)、
  既存の E2E 判定に回帰が無いこと
- `vp check` / `tsc --noEmit` / `vp test run` と、実リレーの既存 E2E が通ること

## 参照

- 調査記録: `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` (media 時刻の飛び、予約の追い越し)、
  `docs/HIGH_LEVEL_API.md` (`boundaryStepCount` / `lateStartCount` の説明)
- `src/playout/audioPlayout.ts` の `AudioPlayoutScheduler.schedule` / `snapToPreviousEnd`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.playSound` / `startBuffer`
- `src/playout/audioPlayoutTimingStats.ts` の `recordBoundaryStep` / `recordLateStart`
- `src/audioSpliceFade.ts` の `fadeSpliceEdge`
- `tests/e2e/relay/investigation-audio-output.spec.ts` (調査用。`MOQT_INVESTIGATION=1` で動く)
