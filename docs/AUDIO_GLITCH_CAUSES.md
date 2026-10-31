# 音声再生の診断

受信、復号、予約、実出力、出力機器の順に観測し、症状が発生した区間を切り分ける。
現在の経路は [音声と映像の再生](PLAYOUT.md)、変更前の仮説と実測は
[過去のノイズ調査](archive/playout/AUDIO_GLITCH_CAUSES.md) を参照すること。
以下の A1 / B4 などは、ソースのコメントと過去の調査で使う識別子である。

## 記録する情報

ブラウザーと OS のバージョン、入力と出力の機器、Bluetooth / 有線の別、
コーデック、配送方式、再生開始からの経過、症状が出た時刻を記録する。
DevTools では `Copy for LLM` のスナップショットと Debug の記録を、症状の前後で保存する。
接続 URI や認可トークンを公開しない。

| 観測する層 | 主な確認項目                                                                        |
| ---------- | ----------------------------------------------------------------------------------- |
| 受信       | Object と Group の欠落、順序、stream reset、重複排除                                |
| 復号       | decoder の状態、エラー、復号出力の媒体 timestamp、入力からの遅れ                    |
| 予約と再生 | `startDelayMs`、`gapMs`、`missedByReason`、圧縮と補間の量                           |
| 出力       | AudioContext の状態、サンプルレート、実出力時計、`baseLatencyMs`、`outputLatencyMs` |
| A/V        | 基準を共有できているか、解除理由、補償量、予約と描画の `skewMs`                     |

フィールドの階層は MediaSubscriber、MediaPlayout、DevTools の表示で異なる。
[再生 API の統計](MEDIA_PLAYOUT.md#統計情報) と [高レベル API の購読統計](HIGH_LEVEL_API.md#統計情報-1)
を確認する。

## A1 / A5: サンプルレート

`sampleRateMismatchFrames` が増えた場合は、`contextSampleRate` と `decodedSampleRate` を確認する。
AudioContext のレートは生成後に変更できないため、復号出力に合う Context を作り直す。
Chromium の Opus 出力には 48 kHz の Context を使い、Catalog の値だけで決めない。

レート不一致の件数は、ノイズや重なりを直接測った値ではない。
44.1 kHz と 48 kHz の比較では、実際のレート変換後の PCM も収録する。
オフラインの一定値で再現したスパイクを、そのまま会話中の原因と断定しない。

## B1 / A5: Bluetooth と狭帯域の出力

`audioContextNarrowband` の警告や Context のレートを確認し、同じ条件で有線と比較する。
マイクの利用開始前後で出力機器、サンプルレート、報告される遅延が変わらないかも記録する。
Bluetooth のプロファイルが切り替わったことや無線区間の欠落は、SDK の計器だけでは確定できない。

ブラウザー内の収録に症状があるかと、実機でだけ聞こえるかを分ける。
`outputLatencyMs` は機器の報告値であり、スピーカーまで音響計測した結果ではない。

## B4: Context の停止と出力切替

`contextState`、`contextStateChanges`、再生を有効にした時刻、機器選択の失敗を確認する。
`audioContextNotRunning` が出た場合は、受信と復号が続いていても予約した音が出ないことがある。

再生 API を直接使う場合は、新しい出力ごとに `prepareAudio()` の完了を待つ。
準備前の pushAudio は error になる。購読や出力を作り直した場合も同じである。
再生中の機器選択が失敗した場合、DevTools は再生を無効にして Context を閉じ、Debug に記録する。
最新の選択が正常に反映されたかを確認してから再開する。

## A2 / A3 / A4 / B2 / B3: 圧縮と補間

通常区間でも `compressedMs` が増え続ける場合は、媒体時刻と出力時計、基準の切り替わりを調べる。
`concealedMs` は生成した続き音の量であり、発話を復元できた量ではない。
周期性が弱い子音と有声音を分け、加工が発生した位置の波形を照合する。

`boundaryStepMax` には正常な発話の急な変化も入る。値が大きいだけでクリックとは判定しない。
同じ PCM と到着列で修正前後を収録し、継ぎ目、振幅、遅延を合わせて比較する。

## B5 / B6: 音切れと末尾

`gapMs` は出力側の補間で覆えなかった穴、`missedByReason` は鳴らすと決めたのに
鳴らなかった音である。媒体の未着、再生段での破棄、停止で切った音を混ぜない。
長い未着で補間上限を超えた穴は、後から届いた入力では修復できない。

末尾だけが欠ける場合は `lastDrain` の待機、`cutMs`、未復号の flush Object を確認する。
Context を閉じる前に drain を待つ。上限で切られた分は正常終了でも計器へ残る。
drain と MediaStream を再生するアプリケーションの停止順も区別する。

## B7: アプリケーションと機器の出力

DevTools の音声は AudioContext の出力機器へ直接接続する。
高レベル API の MediaStream を別の audio 要素で鳴らすアプリケーションでは、その要素の
再生状態と選択した出力機器も確認する。ブラウザー内の予約だけで後段の再生を確認したと扱わない。

波形の収録、WebRTC との比較、活動中の無音の判定は [再生の計測](PLAYOUT_MEASUREMENT.md) を参照すること。
同じ入力をそろえられない比較や、分類できない無音から音質の原因を推測しない。
