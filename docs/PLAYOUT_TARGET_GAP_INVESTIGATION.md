# 再生目標の移動による音声補間の調査

2026-11-09 に、音声の欠落を与えず、映像の到着遅延だけを増やす条件を検証した。
実際の `PlayoutTimeline` が音声の再生目標を後ろへ動かし、予約の隙間を
`AudioRenderConcealer` が補間することを確認した。聴感上のノイズとの対応や、
実環境でこの条件が発生する頻度は未確認である。

## 再現方法

リポジトリのルートで、次の環境変数に調査対象のソースモジュールを設定する。
値には Vite が解決できるモジュール ID を指定する。配置の実値は記録しない。

| 環境変数                        | 対象のモジュール        |
| ------------------------------- | ----------------------- |
| `PLAYOUT_TIMELINE_MODULE`       | `PlayoutTimeline`       |
| `AUDIO_PLAYOUT_MODULE`          | `AudioPlayoutScheduler` |
| `AUDIO_RENDER_QUEUE_MODULE`     | `AudioRenderQueue`      |
| `AUDIO_RENDER_CONCEALER_MODULE` | `AudioRenderConcealer`  |

`<REPRODUCTION_SCRIPT>` を再現スクリプト `investigate-playout-target-gaps.mjs` の配置へ置き換えて実行する。

```console
vp exec node <REPRODUCTION_SCRIPT>
```

再現スクリプトは実クラスへ数値の
到着列と生成した PCM を渡す。ブラウザー API、ネットワーク、コーデックのモックは使わない。
目標値を直接変更せず、タイムラインが計算した目標をスケジューラーへ渡す。

- 音声は 48 kHz、20 ms ごとの連続 PCM を 150 フレーム使用
- 音声の timestamp は 20 ms 刻み、到着は timestamp + 20 ms に固定
- 映像は 40 ms 間隔、基準条件の到着は timestamp + 20 ms
- 比較条件では、映像の timestamp が 1,200 ms を超えてから追加の到着遅延を 4 ms ずつ増やし、100 ms で固定
- 音声の出力先行量の観測値は 3 ms に固定
- PCM はすべて描画前に投入し、出力キューへの配送遅延を排除
- 終了位置を指定し、配信終了後の補間を集計に含めない

## 結果

| 項目                       | 音声と映像の到着が一定 | 映像の到着遅延だけ増加 |
| -------------------------- | ---------------------: | ---------------------: |
| 予約の隙間                 |                   0 回 |                  13 回 |
| 予約の隙間の合計           |                   0 ms |                  50 ms |
| 出力側の補間               |                   0 回 |                  13 回 |
| 出力側で生成した補間の長さ |                   0 ms |                  50 ms |
| 補間できなかった穴         |                   0 ms |                   0 ms |
| スケジューラーの破棄       |                   0 回 |                   0 回 |

両条件とも、時間圧縮と先行伸長の要求は 0 だった。
比較条件の最初の隙間は音声 timestamp 1,820 ms で生じた。
音声の基準遅延 20 ms と jitter buffer 50 ms は変わらず、映像の jitter buffer が
52 ms へ増えたため、同期処理が音声へ 2 ms を追加した。
音声の目標は 1,890 ms から 1,892 ms へ移り、前の音の終端との間に 2 ms の隙間ができた。
その後は主に 4 ms ずつ増え、音声へ追加する同期遅延は 50 ms に達した。

## コード上の経路

1. `PlayoutTimeline.observe()` が、映像の到着時刻と timestamp の差から基準と jitter buffer の遅延を更新する
2. `updateSyncDelays()` が `syncNaturalPresentationMs()` と `alignSyncExtras()` を呼び、遅い映像へ合わせる分を `syncExtraMs.audio` に設定する
3. `presentationPerformanceMs()` が、音声の timestamp に基準遅延と同期遅延を含む表示遅延を足す
4. `AudioPlayoutSession` がこの目標を `AudioPlayoutScheduler.schedule()` へ渡す
5. `AudioPlayoutScheduler` は、前の音の終端との差が 0.5 ms 以下の場合だけ連続する位置へ接続する。それを超えた隙間は残す
6. `AudioRenderConcealer` は、描画位置に実音の予約範囲がないと予測音を出す。後続の実音が既にキューにあるかどうかは、この判断を変えない

`gapMs` は補間できなかった部分だけを数えるため、この経路では 0 のままである。
`missedFrames` と `playoutDrops` も、予約に挿入した隙間の指標ではない。

周期を推定できない入力では、`expandAudio()` が
雑音を線形予測フィルターへ通して予測音を生成する。補間の境界を滑らかにつないでも、
予測音が元の発話と同じになることは保証しない。

## 検証の範囲と次の調査

この再現はタイムライン、スケジューラー、PCM キュー、補間器の連携を検証する。
AudioWorklet の実時間処理、出力時計の変動、描画実績をタイムラインへ返す
フィードバック、OS と出力機器は含まない。音質の聴感評価でもない。

次は実際の発生区間で、`avSync.delays.audio.syncExtraDelayMs` と
`avSync.delays.video.jitterDelayMs` の増加が補間と一致するかを確認する。
音声側の jitter buffer、基準遅延、出力時計の対応の変化も別々に確認する。

再生制御を変更する場合は、実音の欠落と目標変更による待ち時間を区別する必要がある。
すべてを前の音へ直結すると A/V 同期や本当の欠落の扱いが変わるため、今回の確認だけで
連続再生へ置き換える修正はしていない。
