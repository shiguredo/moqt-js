# AudioClockBridge が、供給が続く間の描画の停止を停止として検出しない

- Created: 2026-11-10
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-audio-clock-render-stall
- Polished: {YYYY-MM-DD}

## 目的

`src/playout/audioPlayout.ts` の `AudioClockBridge` は、JSDoc で「`AudioContext` が停止していた (2 つの時計の進みの差が `AUDIO_CLOCK_STALL_MS` 以上) ときは、段差をそのまま取り直す。停止中の `currentTime` は止まるため、上限までずつ補正すると再開直後の予約が未来になり破棄される」と定めている。しかし停止の判定は連続する `update` の間の時計の進みだけを見ているため、メインスレッドの供給 (pushAudio) が続いたまま描画だけが止まった場合は停止を検出しない。その場合、再開後の対応は `AUDIO_CLOCK_MAX_CHANGE_MS` ずつしか補正されず、JSDoc が避けると書いている挙動になる疑いがある。描画だけの停止は、実機でも出力機器の切り替えや描画スレッドの飢餓で起こり得る。検出の漏れを再現テストで確かめ、描画だけの停止も停止として扱う。

## 現状

- `AudioPlayoutSession.updateOutputClock` (`src/playout/audioPlayoutSession.ts`) は、音声の供給のたびに `AudioClockBridge.update` を呼ぶ。引数は `getOutputTimestamp()` の `{ contextTime, performanceTime }` (有効なときだけ)、`context.currentTime`、供給の時刻 (`performance.now()` の軸) である
- `AudioClockBridge.update` の停止の判定 (`stalled`) は、前回の `update` からの「供給の時刻の進み - `currentTime` の進み」が `AUDIO_CLOCK_STALL_MS` (250 ms) 以上かどうかである。供給が 20 ms ごとに続く間に描画だけが止まると、1 回の差は供給の間隔 (20 ms 前後) にしかならず、何回続いても停止として検出されない
- 停止として検出されない場合の平滑化 (`else if` の分岐) は、観測の時刻 (`mapping.performanceTime`) が前回より進んだときだけ対応を動かす。WebKit の `AudioContext::getOutputTimestamp` は出力位置 (`outputPosition`) の位置とその時刻を返し、位置は `currentTime` を超えない。描画が止まっている間に観測の時刻が進まなければ、対応は止まる前の値のまま残る
- 描画が再開すると、観測の対応は止まった量だけ段差で変わる。平滑化の重みは観測の時刻の差で決まるため 1 に近くなるが、1 回の変更は `AUDIO_CLOCK_MAX_CHANGE_MS` (80 ms) で切られ、段差は複数回の供給に分けて補正される
- `src/playout/audioPlayout.test.ts` の「AudioClockBridge: 停止を検出したら対応をそのまま取り直す」は、1 回の `update` の間に `performance.now()` だけが 1 秒進む場面 (メインスレッドも止まった場面) だけを固定している。`src/playout/audioPlayout.prop.ts` の性質も、停止の判定を連続する `update` の差で求めており、供給が続く間の描画の停止を作らない
- CI の webkit-playout (macOS の仮想マシン) で `tests/e2e/media-subscriber-element-playback.spec.ts` を診断すると、`AudioContext` の時計が数百 ms 止まった後、時計の遅れ (`currentTime * 1000 - performance.now()` の最大との差) が横ばいの区間でも backlog による破棄が連続した (例: 遅れ 284〜287 ms のまま 5 回の供給が続けて破棄された区間が 2 か所)。止まっている間に予約が積み上がって起きる破棄 (供給のたびに遅れが約 20 ms ずつ増える区間の破棄) とは形が違う。ただし、この破棄が上の検出の漏れによるものかは確かめていない (目標遅延や A/V 同期の待ちの変化でも起こり得る)。経緯は `docs/PLAYOUT_REDESIGN_REVIEW.md` の「実行環境の乱れの切り分け (2026-11-10 追記)」にある

## 設計方針

- まず再現テストを書く。`AudioClockBridge` に、供給の間隔 (20 ms) で `update` を続けながら `currentTime` と `getOutputTimestamp()` の値を止め、止まった量 (250 ms 以上) の後に再開する列を与え、再開直後の `toAudioSeconds` が実際の `AudioContext` の時計とどれだけずれるかを確かめる。ずれが `AUDIO_CLOCK_MAX_CHANGE_MS` 単位の補正で残ることを、修正前に失敗するテストとして固定する
- 停止の判定を、連続する `update` の差ではなく、観測が進んだ 2 点の間の「`performanceTime` の進み - `contextTime` の進み」(代用のときは `currentTime` と供給の時刻) で行う。描画だけが止まった場合も、再開後に最初に進んだ観測で段差を検出し、対応をそのまま取り直す。メインスレッドも止まった場合の既存の挙動 (1 回の `update` で段差を検出する) は変えない
- `AudioClockBridge` の JSDoc と `audioPlayout.prop.ts` の停止の判定の写しを、新しい判定に合わせる

### 対象外

- `tests/e2e/media-subscriber-element-playback.spec.ts` の破棄の許容の条件 (時計の遅れの累計で許す) は、この issue では変えない

## 完了条件

- 供給が続く間に描画だけが `AUDIO_CLOCK_STALL_MS` 以上止まった後、再開して最初に進んだ観測で対応を段差のまま取り直すこと。これを固定する単体テストが `src/playout/audioPlayout.test.ts` にあり、修正前の実装では失敗すること
- メインスレッドも止まった場合の既存のテスト「AudioClockBridge: 停止を検出したら対応をそのまま取り直す」と、平滑化の上限・同じ観測の再読のテストが引き続き通ること
- `src/playout/audioPlayout.prop.ts` の停止の判定の写しが新しい判定と一致し、描画だけが止まる列も生成すること
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/playout/audioPlayout.ts` の `AudioClockBridge` (`update` / `reset` / `toAudioSeconds`)、`AUDIO_CLOCK_STALL_MS` / `AUDIO_CLOCK_MAX_CHANGE_MS` / `AUDIO_CLOCK_SMOOTHING_MS`
- `src/playout/audioPlayoutSession.ts` の `AudioPlayoutSession.updateOutputClock`
- `src/playout/audioPlayout.test.ts` の `AudioClockBridge` のテスト群、`src/playout/audioPlayout.prop.ts` の対応の性質
- `docs/PLAYOUT_REDESIGN_REVIEW.md` の「実行環境の乱れの切り分け (2026-11-10 追記)」
- WebKit の `Source/WebCore/Modules/webaudio/AudioContext.cpp` の `AudioContext::getOutputTimestamp`
- Web Audio API の `getOutputTimestamp()` (https://webaudio.github.io/web-audio-api/#dom-audiocontext-getoutputtimestamp)
