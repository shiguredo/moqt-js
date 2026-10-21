# 音声の到着遅れからメインスレッドの停止分を分離して計器に出す

- Created: 2026-10-21
- Completed: 2026-10-21
- Branch: feature/add-devtools-audio-playout-instruments
- Polished: {YYYY-MM-DD}

## 目的

音声の到着の遅れ (`receiveDelayMs`) と jitter 推定の入力は、メインスレッドの async ループで
測るため「リレーと経路の遅れ」と「同じページのメインスレッド停止」の和になる。devtools は
1 ページで配信と購読を同時に行うため、映像の描画や復号コールバックの影響が混入し、遅延の
原因を誤って経路側と判定し得る。停止分を分離して計器に出し、遅延の所在を正しく読めるように
する。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamStartDatagramLoop` はメインスレッドの
  async ループで `reader.read()` し、`handleIncomingDatagram` を同期で呼ぶ。到着時刻は
  `devtools/src/hooks/useSubscriber.ts` の `queueAudioObject` と
  `src/createMediaSubscriber.ts` の `receiveAudioObject` で `performance.now()` で取る。
  この時点でメインスレッドが止まっていれば、実際のネットワーク到着より遅い時刻になる
- `PerformanceObserver` の `longtask` は調査スクリプトで使っているが、devtools の計器には
  入っていない
- 既存の計測では、映像を止めても到着の尾は変わらない一方、符号化 worker を外すと到着の
  p95 が悪化する。メインスレッドの影響は無視できない

## 設計方針

- 長いメインスレッド停止を扱う純粋な論理 (`HostDelayTracker`) を追加する。
  `PerformanceObserver` に依存せず、`startMs` と `durationMs` の組を受け取って
  「到着間隔のうち停止区間と重なるもの」を数える
- devtools は `PerformanceObserver` の `longtask` で監視し、停止区間を tracker へ渡す。
  1 秒ごとの統計に「停止回数」「停止合計 ms」「停止と重なった到着の数」を出す
- 到着遅れの推定から停止分を除くかは、この計器で分離できた後に判断する。この issue では
  計器の追加だけを行い、推定の挙動は変えない

## 完了条件

- `HostDelayTracker` の単体テスト (停止区間と到着が重なる / 重ならない / 境界) を追加する
- devtools の音声統計 (Copy for LLM の JSON と Audio Playback の表示) から停止回数と
  停止 ms が読める
- devtools の実リレー E2E で、停止が無い回は停止回数が 0 であることを確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通ること

## 解決方法

音声の到着時刻がメインスレッドの event loop 遅れを含む問題に対して、`PerformanceObserver` の `longtask` を
観測する `HostDelayTracker` (`devtools/src/utils/hostDelayTracker.ts`) を追加した。停止区間と、その停止を
待って観測された音声の到着の間隔を突き合わせ、直近 10 秒の停止回数・停止合計 ms・停止と重なった到着数を
数える。`devtools/src/hooks/useSubscriber.ts` は音声の購読開始で監視を始め、500 ms ごとに
`audio.hostDelay` として signal へ反映し、`statsSnapshot` と Audio Playback の画面に出す。停止区間中は
同じスレッドの到着コールバックが動かないため「到着が停止区間の内側か」ではなく「直前の到着から今回の
到着までの間隔が停止区間と重なるか」で数える。`PerformanceObserver` が無い、または `longtask` を
報告しない環境では何もしない。到着遅れの推定の挙動は変えていない。

検証: `HostDelayTracker` の単体テスト (停止区間の内側・外側・境界、複数停止、古い停止の破棄) を追加。
`vp check` / `tsc --noEmit` / `vp test run` (236 ファイル / 4179 テスト) が通り、軽量な Playwright
(`devtools-audio-playback`) も 2 件成功した。
