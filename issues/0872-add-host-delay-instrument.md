# 音声の到着遅れからメインスレッドの停止分を分離して計器に出す

- Created: 2026-10-21
- Completed: {YYYY-MM-DD}
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

{対応時に記入}
