# 再生の計測

低遅延と音切れの削減を一緒に評価するための手順をまとめる。
実行した版と各試行の結果は [調査記録](archive/README.md#再生) に分けて残す。
診断の入口は [音声再生の診断](AUDIO_GLITCH_CAUSES.md) を参照すること。

## 比較する境界

| 比較                       | そろえる入力                                | 分かること                                      |
| -------------------------- | ------------------------------------------- | ----------------------------------------------- |
| DSP の直接比較             | 同じ PCM、レート、加工の上限                | 周期判定、継ぎ目、加工した長さ                  |
| 同じ出力時計の修正前後比較 | 同じ復号 PCM、同じ Context、同じ到着列      | 予約と出力の変化                                |
| Chrome WebRTC との比較     | 受信 transform で複製した同じ Opus パケット | 実 NetEq 経路と SDK の遅延、出力の差            |
| 実リレーの比較             | 実際の配信と購読、受信列、復号と再生の記録  | QUIC を含む経路の振る舞い                       |
| 実機の音響測定             | 同じ入力と実際の出力機器                    | Bluetooth、スピーカー、外部出力までの遅延と症状 |

WebTransport / QUIC の転送と媒体の再生期限は別の層である。
ブラウザー内の収録だけで実機の音質を確認したと扱わず、受信後に損失を注入した条件を
回線の輻輳まで含む損失と同一視しない。

## 用意するもの

SDK の依存関係と Chromium を [開発と検証](DEVELOPMENT.md) の手順で用意する。
Google Chrome を使う場合は `PLAYOUT_BROWSER_CHANNEL=chrome` を指定する。
日本語の音源は次のスクリプトで用意する。取得元と音源の条件は
[音源の調査記録](archive/playout/AUDIO_PLAYOUT_QUALITY_INVESTIGATION.md#日本語の音源) にある。
この準備スクリプトは macOS の say、指定した音声、ffmpeg とネットワーク接続を必要とする。

```bash
vp exec node scripts/prepare-playout-japanese.mjs
```

## 実行するモード

```bash
PLAYOUT_BROWSER_CHANNEL=chrome PLAYOUT_AV_SECONDS=6 \
  vp exec node scripts/investigate-playout-audio.mjs webrtc
```

| モード                                | 用途                                            |
| ------------------------------------- | ----------------------------------------------- |
| `dsp` / `waveform`                    | 加工の単体比較、レート変換と継ぎ目              |
| `render` / `speech` / `live` / `long` | 合成入力と発話の再生、長時間の出力              |
| `datagram` / `datagramLive`           | 制御した媒体欠落と再生                          |
| `relay` / `avRelay`                   | 実リレーを使う音声と A/V の計測                 |
| `replay`                              | 保存した到着記録の再投入                        |
| `av`                                  | 音声予約と実 canvas 描画の比較                  |
| `webrtc`                              | 同じ Opus パケットによる Chrome WebRTC との比較 |
| `deadlines`                           | 保存した音声記録を使う予約期限の計測            |

`all` はすべてのモードを実行する指定ではない。実リレー、保存記録、比較向けの一部モードは
明示して実行する。音源や記録を必要とする条件の詳細は、各スクリプトの入力検査を確認する。

## 修正前後を比較する

比較元の src/ を別のディレクトリへ取り出し、対象を固定する。
次の例は `20985ca8` の親を比較元にし、現在の作業ツリーと比べる。

```bash
mkdir -p investigation-logs/playout-before
git archive 20985ca8^ src | tar -x -C investigation-logs/playout-before
PLAYOUT_BROWSER_CHANNEL=chrome PLAYOUT_AV_SECONDS=6 \
  PLAYOUT_WEBRTC_PATTERNS=clean,recurring60,jitter30,step60 \
  PLAYOUT_COMPARE_SOURCE_ROOT=investigation-logs/playout-before/src \
  vp exec node scripts/investigate-playout-audio.mjs webrtc
```

`PLAYOUT_COMPARE_SOURCE_ROOT` は `av`、`waveform`、`webrtc` で使える。
`PLAYOUT_WEBRTC_PATTERNS` は上記の 4 種類を選択し、`PLAYOUT_CASE_FILTER` はケース名で絞り込む。
要求した到着列が同じでも、実時間での投入と出力時計は反復ごとに変動するため、複数回測る。

生データ、環境、ソースと音源のハッシュ、WAV / Float32 は
investigation-logs/playout-quality-2026-10-28/runs/ の実行ごとのディレクトリへ保存する。
日付を含むパスは既存の保存先の名前であり、実行日は各環境記録を読む。
収録中はソースを変更せず、解析、ビルド、別の媒体試験を並行しない。

## 収録を採用する条件

- ソース、比較元、計測コード、音源のハッシュが収録中に変わっていない
- 必要な AudioContext と AudioWorklet が実際に動き、後始末まで確認できている
- 全フレームと収録区間を確認し、収録器の例外やサンプルの欠落が無い
- 同じ Opus の比較では、送受信パケットの対応と保存パケットの再復号 PCM が一致する
- 予約の時計と実適用した伸縮を再投入し、予約の判断を照合できる
- 振幅が消えて段差だけが減った結果を合格にしない

例外や欠落で無効な収録と、収録は有効だが波形を照合できない区間を分ける。
起動、定常、回復後、停止後の無送信を同じ分布へ混ぜない。
終端が分かる試験は drain と予約の終了フレームで収録完了を待つ。

## 波形と遅延を解析する

WebRTC 比較の収録が終わってから、run ディレクトリを解析スクリプトへ渡す。

```bash
run_directory=investigation-logs/playout-quality-2026-10-28/runs/RUN_DIRECTORY
vp exec node scripts/summarize-webrtc-playout.mjs "$run_directory"
```

RUN_DIRECTORY は実行時に生成されたディレクトリ名へ置き換える。

時間伸縮する出力には、全体で 1 個の相関や遅延を当てない。
局所的に照合し、原音の活動量、相関、競合ピークとの差で採否を決める。
符号化と復号の固定遅延の校正が不安定な条件は、原音基準の遅延を null として残す。
出力ごとに採用窓が異なるため、各出力の中央値だけで比較せず、同じ参照位置の差も確認する。

完全無音は、前後の高相関の区間から参照音声の活動が確認できるもの、静かなもの、
判定できないものに分ける。活動中の無音が 0 ms でも、判定できない区間を含む音切れ 0 の
証明にはならない。相関、段差、振幅は MOS や聴感の評価値ではない。

A/V は映像の直前 40 ms 以内の音声と組にし、それぞれの媒体時刻から求めた遅延の差を読む。
音声と映像の実際の組数を結果に残し、同じ TIMESTAMP の組数へ固定しない。
集計の百分位の定義と標本数はスクリプトごとに確認する。異なる定義の過去の表を上書きしない。

## 結果を記録する

対象の commit または source tree のハッシュ、ブラウザー、OS、レート、音源、条件、反復数、
採用と棄却の件数を記録する。遅延、活動確認付きの無音、不明区間、処理負荷、
振幅と継ぎ目を併記し、採用しなかった案も理由を残す。

現在の方式の説明へ測定表を複製せず、[調査記録](archive/README.md) に日付と比較元を付けて残す。
実機で未確認の範囲、実リレーの有無、再生計器だけでは見えない後段も明記する。
