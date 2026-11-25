# 実リレーの音声 E2E が main thread 負荷で間欠的に失敗するのを解消する

- Created: 2026-11-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-relay-main-thread-load-audio-flake
- Polished: {YYYY-MM-DD}

## 目的

CI の `e2e-test` の `relay (2)` が、実装の退行ではなく実行環境の負荷で間欠的に失敗して develop を赤くするのを解消する。2026-11-25 の run では同じコミットでも初回に 3 件失敗し、再実行で 2 件が通り、残る 1 件が再実行でも失敗した。この 1 件は前提条件 (配信側の棄却が起きること) を作ったうえで「音声が壊れていない」ことを見るテストであり、そもそも何を壊れたとみなすかが実行環境に依存している。

## 現状

2026-11-25 の [e2e-test run 45595143555](https://github.com/shiguredo/moqt-js/actions/runs/45595143555) の `relay (2)` (shard 2) で、次の 4 件が失敗した。同じコミット `802a06661dc2f6c545d977c0762efa07dbd7f766` を [再実行](https://github.com/shiguredo/moqt-js/actions/runs/45609445421) すると、最後の 1 件だけが再び失敗した。直前の成功は run 45511403809 (`51a16393`) であり、その間の差分はドキュメントと issue だけで、音声のコードは変わっていない。

- 初回のみ: `tests/e2e/relay/devtools-audio-playback-lifecycle.spec.ts` の「購読の停止後に購読をやり直しても、音声の再生を続けられる (直列化された再購読)」と「音声の再生を押した直後に購読を止めても、再生の状態とアプリのエラーが壊れない」
- 初回のみ: `tests/e2e/relay/devtools-both-audio.spec.ts` の「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」
- 初回と再実行の両方: `tests/e2e/relay/devtools-both-audio.spec.ts` の「負荷で配信側の棄却が起きても、音声が壊れない (境目のフェード)」

初回のみ失敗した 3 件は、いずれも `startBoth` の「配信側が音声の Object を送り始めるのを待つ」で `objectsSent` が 0 のまま 30 秒のタイムアウトに達した。テストの判定ではなく、配信が始まる前の待ちで落ちている。

再実行でも失敗した 1 件は次のとおりである。`applyMainThreadLoad` でメインスレッドを 60 ms 占有し 40 ms 明け渡す負荷を `LOAD_MS` (10 秒) かけ、2 回目 (40 秒相当) まで実行したうえで、`missedFrames` が 5 以下であることを求めている。

```
missedFrames=58(backlog=57/catchUp=1), rebases=21, concealedMs=3215, concealments=90,
gapCount=6, maxReceiveDelayMs=2042, droppedMs=380, catchUpStarts=1
Expected: <= 5 / Received: 58
```

`backlog` は `AUDIO_PLAYOUT_BACKLOG_SECONDS` (300 ms の上限から基準の遅延を引いた値) を超えて並んだ音を捨てたという意味である (`docs/HIGH_LEVEL_API.md` の「統計情報」の `missedByReason`)。同じ試行で `receiveDelayMs` は 146 ms のままなのに `maxReceiveDelayMs` だけ 2042 ms であり、その期間だけ到着が遅れている。テスト側は「負荷で配信側の棄却が起きたこと」だけを確かめてから、購読側の棄却を「音声が壊れた」とみなしている。

初回の「配信が始まらない」3 件については、`relay (2)` の直前のテストが `WebTransportError: Opening handshake failed.` を出している。`isNetworkConsoleError` がこの文言を判定から除くため、テストはそのまま進み、接続が確立しないまま待ち続ける。接続の失敗と配信が始まらないことを切り分ける観測が無い。

## 設計方針

- assert や許容値を緩めない。失敗した回が実行環境の負荷や接続の失敗で説明できるかを、追加の観測で示す。固定 sleep や `--retries` の追加で隠さない
- 配信が始まらない経路: `startBoth` の待ちを、配信の開始要求の結果 (`status` / エラー / 接続の状態) も見る形にする。接続が確立していない、または PUBLISH が拒否された場合は、待ち切る前に原因を失敗メッセージへ出す。経路の失敗と実装の退行を区別できるようにする
- 負荷を与えるテスト: `missedByReason` と `recentMisses` を使って、棄却の理由と発生時刻を失敗メッセージに出す。到着の遅れ (`maxReceiveDelayMs` と `receiveDelayMs` の差) と、購読側の棄却が同じ期間に起きているかを示す
- 配信側の棄却 (テストの前提) と購読側の棄却 (壊れたとみなす) を分けて扱う。負荷で到着が遅れたことによる購読側の `backlog` は、その遅れを観測で示せた回に限って判定から切り分ける。示せない回は今までどおり失敗させる
- 判定を緩める前に、まず同じ負荷で複数回実行して `backlog` の件数と `maxReceiveDelayMs` の関係を測る。測った結果に基づいて閾値と切り分けの条件を決める。推測で決めない
- 変更は E2E のテストと支援コードに閉じ込め、製品コードの再生判定には影響させない

## 完了条件

- 初回に失敗した 3 件について、接続の失敗と PUBLISH の失敗と「配信が遅いだけ」を区別できる観測が入り、失敗時にどれだったかがメッセージから分かる
- 負荷のテストについて、購読側の `backlog` が実行環境の到着遅れで説明できるかを判定できる観測が入っている。説明できない回は失敗する
- GitHub Actions の `relay (2)` で対象テストを複数回実行し、すべての試行結果と実行環境の観測を残している
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

## 参照

- `tests/e2e/relay/devtools-audio-playback-lifecycle.spec.ts` の `startBoth` / `startRelayPair` / `isNetworkConsoleError`
- `tests/e2e/relay/devtools-both-audio.spec.ts` の「負荷で配信側の棄却が起きても、音声が壊れない (境目のフェード)」/ `applyMainThreadLoad` / `LOAD_MS` / `LOAD_SPIN_MS` / `LOAD_YIELD_MS`
- `src/playout/audioPlayout.ts` の `AUDIO_PLAYOUT_BACKLOG_SECONDS`
- `src/playout/audioPlayoutTimingStats.ts` の `AudioMissReason` / `missedByReason` / `recentMisses`
- `docs/HIGH_LEVEL_API.md` の「統計情報」の `missedFrames` / `missedByReason`
- `.github/workflows/ci.yml` の `e2e-test` の `relay` ジョブと再実行のステップ
- 失敗した run: https://github.com/shiguredo/moqt-js/actions/runs/45595143555 (初回) / https://github.com/shiguredo/moqt-js/actions/runs/45609445421 (再実行)
- open `1009-test-devtools-long-run-receive-delay-flake.md` / open `0959-test-webkit-playout-residual-flake.md`
