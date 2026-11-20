# 長時間配信の受信遅延テストの間欠的な失敗を解消する

- Created: 2026-11-17
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-devtools-long-run-receive-delay-flake
- Polished: 2026-11-17

## 目的

実リレーを使う長時間配信テストの間欠的な失敗を調査し、受信遅延の退行を検出する目的を保ちながら、CI の判定を安定させる。実装の退行と実行環境の乱れを区別できていない状態で、上限値の緩和や再実行だけによって失敗を隠さない。

## 現状

- `devtools-both-audio` の「長時間の配信で、送信の遅れと受信の遅れが悪化しない」は、配信と購読を継続し、`worstReceiveDelayMs` が 1,000 ms 未満であることを確認する。
- 2026-11-17 の [e2e-test run 43977216169](https://github.com/shiguredo/moqt-js/actions/runs/43977216169) の shard 2 の初回試行で、`worstReceiveDelayMs` が 1226.39990234375 ms となり失敗した。診断 artifact は `e2e-relay-test-results-shard2-attempt1` に保存されている。
- 同じコミット `3fa772dadc2a4e5b1eb37ecd136ea7ec57502961` に対する [e2e-test run 43976854292](https://github.com/shiguredo/moqt-js/actions/runs/43976854292) の shard 2 は、初回試行で成功している。今回の操作変更との因果関係は未確認であり、原因を実行環境と断定しない。
- テストはメインスレッドの停止、送受信の遅れ、音声と映像の `DelayStallSample` を採り、`disturbed` を使って一部の判定を分けている。ただし、`worstReceiveDelayMs` の上限は `disturbed` にかかわらず判定する。
- `testInfo.attach` へ本体として渡す時系列データは、relay project の trace を無効にした現在の artifact 保存方法では残らない。原因の調査では、CI ログと失敗時の時系列を合わせて確認できるようにする必要がある。

## 設計方針

- GitHub Actions で対象テストを繰り返し、正常時と失敗時の `worstReceiveDelayMs`、送信の遅れ、メインスレッド停止、音声時計と再生の状態を比較する。必要な接続設定は既存の `TEST_MOQT_URI` を使い、接続情報の実値は記録しない。
- 失敗した試行の時系列を artifact に残し、送信、配送、復号、再生待ちのどこで遅れが生じたかを特定する。観測が足りない箇所だけを補う。
- 実装が原因ならその経路を修正し、実行環境が原因なら独立した観測で示す。固定 sleep の追加、上限値の緩和、根拠のない失敗の無視は行わない。
- open 0949 の音声時計の停止検出との関連は調査で確認する。open 0959 は WebKit の実時間テストを対象としており、本件の実リレーを使う Chromium の試験とは区別する。

## 完了条件

- 受信遅延の上限を超えた原因を、失敗時の時系列とコードの経路に基づいて説明できる。
- 原因に対応した修正と検証があり、実装の退行を検出する判定を維持している。
- 修正後の対象テストを GitHub Actions で複数回実行し、すべての試行結果と実行環境の観測を残している。
