# 実リレー E2E の live 判定を受信遅れの瞬時値に依存させない

- Created: 2026-11-22
- Completed: 2026-11-22
- Branch: feature/fix-relay-live-judgment-flake
- Polished: 2026-11-22

## 目的

実リレー E2E の「cache を再生せず live へ戻る」判定が、経路の一時的な遅れで失敗するのをなくす。判定は再生側で観測できる「復号済み音声がどれだけ古いか」で行い、到着時点の受信遅れは診断値として扱う。閾値の一律緩和や再実行による失敗の隠蔽はしない。

## 現状

- `tests/e2e/relay/devtools-both-audio.spec.ts` の `expectLive` は、`audio.receiveDelayMs < 300`、`audio.playoutCatchUp.lagMs < 300`、`audio.playoutTiming.startDelayMs.p50 < 1000` を確認する。`receiveDelayMs` は Object の到着時に測る「受信した壁時計 - LOC TIMESTAMP」であり、その瞬間の経路と relay の遅れを含む。cache 再生の有無を直接表す値ではない。
- 「購読のやり直しを繰り返しても、毎回 live の音声へ戻る」も、復帰待ちの条件に `audio.receiveDelayMs < 300` の単一サンプルを使っている。
- 2026-11-22 の [e2e-test run 45016963709](https://github.com/shiguredo/moqt-js/actions/runs/45016963709) の再実行で、「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」が `audio.receiveDelayMs = 359` で失敗した。同じ時点の `audio.playoutCatchUp.lagMs = 169`、`audio.playoutTiming.startDelayMs.p50 = 81`、`sharingBases = true`、`warnings = 0` はすべて判定の範囲内だった。1 個の遅着 Object が瞬時値だけを押し上げた。
- 同じ run の再実行の初回試行では、同じテストを含む 4 本が 30 秒前後で失敗した。映像の到着 p95 は 748.8 ms で、メインスレッドの停止は 40 ms、配信側の送信の遅れの最大は 102 ms だった。ローカルの停止や配信側の詰まりではなく、経路が乱れた回である。再試行で 3 本は回復し、残った 1 本が上の 359 ms だった。
- 同じファイルの長時間試験は `RECEIVE_DELAY_DISTURBED_MS = 200` を「環境の乱れ」の基準に使っている。受信遅れ 200 ms 以上を乱れとみなす基準と、`expectLive` の無条件の 300 ms 判定が並立しており、同じ観測値の扱いが揃っていない。
- run の conclusion は再実行で成功した時点で success になるため、run 一覧の失敗率だけでは今回の失敗は見えない。attempt ごとのログを見ないと残らない。
- 長時間試験の受信遅延は open 1009 で扱う。WebKit の実時間判定は 0959 の対象。本 issue は、再試行に残った live 判定の失敗を対象にする。

## 設計方針

- live の定義を「cache や復号の溜まりを鳴らしていない」に限定し、経路の絶対遅延の SLA と分ける。
- 主指標は `audio.playoutCatchUp.lagMs` (復号の出力の遅れ) とする。cache を復号していれば秒単位になり、1 個の遅着 Object ではほとんど動かない。`audio.playoutCatchUp.catchingUp` と `audio.playoutTiming.startDelayMs` を併用する。
- `audio.receiveDelayMs` は診断値として残す。判定に使う場合は、単一サンプルではなく直近の複数サンプルの中央値や 1 秒間の最小値を使い、`RECEIVE_DELAY_DISTURBED_MS` を超える回を経路の乱れとして扱う。1 点の遅着で失敗させない。
- 判定を純粋関数として `devtools/src/utils/` に切り出し、`expectLive` と反復復帰の待ち条件で同じものを使う。テストのための分岐を製品の再生経路へ入れない。
- 単体テストで次を固定する。受信遅れが 1 点だけ 359 ms で `lagMs` が 169 ms の系列は live、`lagMs` が 2 秒以上の系列は cache 再生として不合格、再生が始まっていない系列は不合格。
- 固定 sleep、閾値の一律緩和、失敗時の握り潰しはしない。失敗時はサンプル系列と判定理由をメッセージに残す。

## 完了条件

- live 判定が単一サンプルの `audio.receiveDelayMs` に依存しない。
- 単体テストで「1 点の遅着は合格」「cache 再生は不合格」「再生前は不合格」を固定している。
- 対象の 3 本 (後から購読 / やり直し / 繰り返し) を GitHub Actions で複数回実行し、経路の遅れで失敗しないことを確認している。失敗した回はサンプル系列を artifact かログに残す。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。
- 長時間試験 (1009) の判定は変更しない。

## 参照

- `tests/e2e/relay/devtools-both-audio.spec.ts` の `expectLive`、`RECEIVE_DELAY_DISTURBED_MS`、「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」「購読をやり直しても、cache から配られた分を飛ばして live へ復帰する」「購読のやり直しを繰り返しても、毎回 live の音声へ戻る」
- `devtools/src/utils/delayStallReport.ts` (実リレーのテストが既に import している純粋関数の例)
- `src/playout/audioReceiveCatchUp.ts` の `AudioReceiveCatchUpStats.lagMs`
- `tests/e2e/relay/support.ts` の `RELAY_TEST_TIMEOUT_MS`
- `.github/workflows/e2e-test.yml` の relay ジョブの再試行とタイムアウト
- 失敗した run: [45016963709](https://github.com/shiguredo/moqt-js/actions/runs/45016963709) / 同じ変更を含む run: [45015728187](https://github.com/shiguredo/moqt-js/actions/runs/45015728187), [45016453023](https://github.com/shiguredo/moqt-js/actions/runs/45016453023)
- open 1009 (長時間試験) / open 0959 (WebKit) / closed 0811 (e2e ジョブのタイムアウト)

## 解決方法

`devtools/src/utils/liveAudio.ts` に、音声が live かどうかを判定する純関数を追加した。復号済み音声の古さ (`audio.playoutCatchUp.lagMs`) と鳴り始めの遅れ (`audio.playoutTiming.startDelayMs.p50`) を窓内の中央値で見る。受信の遅れ (`audio.receiveDelayMs`) は 1 個の遅着 Object で跳ねるため判定に使わず、失敗メッセージに残す診断値にした。既存のしきい値 (300 ms / 1000 ms) は変えていない。

`tests/e2e/relay/devtools-both-audio.spec.ts` の `expectLive` は 5 点を 100 ms 間隔で取るようにし、「配信の途中から購読しても、cache から配られた分を飛ばして live へ復帰する」「購読をやり直しても、cache から配られた分を飛ばして live へ復帰する」「購読のやり直しを繰り返しても、毎回 live の音声へ戻る」で共有した。反復復帰の待ち条件も同じ判定にした。

`devtools/src/utils/liveAudio.test.ts` で、受信遅れが 1 点だけ 359 ms に跳ねた系列は live、`lagMs` が古い系列は cache 再生として不合格、再生前は不合格となることを固定した。

検証:

- 単体テスト 5 件、`vp test run` 5,613 件、`vp check`、`tsc --noEmit` が成功
- PR #577 の CI がすべて成功。実リレーの relay (2) は 20 件すべて成功し、対象の 3 本と長時間試験を含む
- develop の `e2e-test` には、本変更とは無関係の `devtools-subscribe-tracks-subgroup` のリレー側 `duplicate object has a different payload` の失敗が残っている (1009 の範囲でも本件の live 判定でもない)
- マージコミットは dcfe6764

長時間試験 (1009) の判定は変更していない。
