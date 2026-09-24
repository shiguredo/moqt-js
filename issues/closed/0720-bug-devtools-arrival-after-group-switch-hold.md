# moqt-devtools の到着の揺らぎと遅延が、Group の切り替えで保留した時間を到着の遅れに含める

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-devtools-arrival-after-group-switch-hold
- Polished: {YYYY-MM-DD}

## 目的

moqt-devtools の subscriber の統計 `playbackTiming` の `arrivalJitterMs` (到着の揺らぎ) と `latencyMs` (送信から受信までの遅延) は、映像の Object がアプリに届いた時刻で求めることになっている。実際には Group の切り替えの保留 (`GroupSwitchGate`、最大 50 ms) を通った後の時刻で求めている。保留された Object (次の Group の先頭のキーフレームとその後続) では、保留した時間が到着の遅れとして数えられる。

受信側の映像がかくつく原因を、経路 (relay と回線) の到着の遅れと受信側の処理の遅れに切り分けるには、到着時刻が正しい必要がある。止まりの原因を分ける統計を足す前提として直す。

## 現状

- `devtools/src/hooks/useSubscriber.ts` の購読の `object` コールバックは、Object を `videoGroupGateRef` (`GroupSwitchGate`) に渡す。前の Group の Subgroup の stream が開いている間、次の Group の Object は保留され、前の Group の stream の終わり (`subgroupEnd`) か保留の上限 (`GROUP_SWITCH_HOLD_MS` = 50 ms) で `enqueueVideoObjects` に渡る
- `enqueueVideoObjects` は Object を Promise チェーンに積み、`handleObject` が処理する
- `handleObject` は `playbackTimingRef.current.recordArrival(performance.now(), ...)` で到着を記録する。この `performance.now()` は保留を解いた後の時刻であり、Object がコールバックに届いた時刻ではない
- jitter buffer (`PlayoutBuffer`) は復号の出力の時刻を使う (表示できるようになった時刻であり、保留を含むのが正しい) ため、この問題の影響を受けない

## 設計方針

- `object` コールバックで受け取った時刻 (`performance.now()`) を Object と一緒に保留へ渡し、`handleObject` はその時刻で到着を記録する
- 保留の型は `{ object, receivedAtMs }` とし、`GroupSwitchGate` 自体は変えない (保留する値の型は呼び出し側が決める)

## 完了条件

- 保留を通った Object の到着を、コールバックで受け取った時刻で記録することを単体テストで固定する (実物の `GroupSwitchGate` と `PlaybackTimingStats` を使う)
- `vp check` と全テストが通る

## 解決方法

- `devtools/src/hooks/useSubscriber.ts` に `ReceivedVideoObject` (`object` と `receivedAtMs`) を足した。購読の `object` コールバックは受け取った時刻 (`performance.now()`) を Object と一緒に `GroupSwitchGate<ReceivedVideoObject>` へ渡し、`handleObject` は保留を通った `ReceivedVideoObject` を受け取る
- 到着の記録を `recordVideoArrival` に切り出した。`receivedAtMs` で `PlaybackTimingStats.recordArrival` を呼び、TIMESTAMP が壁時計のときは `performance.timeOrigin + receivedAtMs` で遅延を求める。TIMESTAMP が無ければ記録しない
- テスト (`useSubscriber.test.ts`): 実物の `GroupSwitchGate` と `PlaybackTimingStats` で、Group 0 の stream が開いている間に 40 ms に受け取った Group 1 の先頭を 90 ms に保留から解き、遅延が 40 ms、到着の揺らぎが 0 ms になることを確かめる (保留を解いた時刻で記録すると 90 ms と 50 ms になる)。TIMESTAMP の無い Object は記録しないことも確かめる
- `vp check`、`tsc --noEmit`、全テスト (134 ファイル / 2694 件) が通った
