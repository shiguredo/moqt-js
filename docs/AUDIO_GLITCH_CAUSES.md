# playout の音声ノイズの原因候補 (ジジジ / Bluetooth のプツプツ)

2026-10-29 の更新案内: 以下は d0b944dd を対象にした 2026-10-27 の原因候補と検証の記録である。
現行では元のサンプルレートで周期を選び、圧縮前の履歴から PLC を行い、補間と実音の接続、
通常の境界の振幅変調、終端のサンプル丸めを修正した。旧遅延制御の計器は削除している。
本稿の候補順位と旧切り分け手順を現在の診断結果として使わないこと。
再現を確認した修正は [音声波形の調査](AUDIO_PLAYOUT_QUALITY_INVESTIGATION.md)、
現在の計器と未確認事項は [音声再生の現状](AUDIO_PLAYOUT_RESULT.md) を参照すること。
Bluetooth と実機の聴感、および物理的なリップシンクは引き続き未検証である。

DevTools の出力は、その後 `AudioContext.destination` への直接出力に変更した。
出力デバイスも同じ Context で選び、旧 `<audio>` 要素のイベント計器は、Context の
`baseLatencyMs` / `outputLatencyMs` に置き換えた。以下の二段構成と B7 の説明は当時の
構成であり、現在の DevTools には適用しない。ライブラリの MediaStream 出力と区別すること。
現在の計測は [DevTools の実出力経路と A/V 遅延](DEVTOOLS_AUDIO_LATENCY.md) を参照する。

2026-10-27 に利用者から届いた次の 2 件のフィードバックについて、起き得る原因を洗い出し、
可能性の高い順に並べ、切り分け方法を整理した記録である。調査の後、A1 と A2 の一部を
2026-10-27 に実装した (「実装した変更」の節)。

- 症状 A: 話をしていると「ジジジ」といったノイズが乗る。回線は良好であり、playout 側が疑わしい
- 症状 B: Bluetooth 接続のマイクやスピーカーを使うと「プツプツ」する

オノマトペの解釈は確定ではない。ここでは「ジジジ」を連続的・周期的なざらつき / ブザー音、
「プツプツ」を離散的なクリック / 途切れと解釈して候補を並べた。両方が同じ原因で起きる場合も
含めて洗い出している。

対象は `develop` の `d0b944dd` (2026-10-27) である。調査は実ブラウザ (Playwright 同梱の
Chromium 156.0.8078.4) での実験、本番モジュールの直接駆動、コード読解、一次情報で行った。
生データと再現スクリプトは `investigation-logs/glitch-2026-10-27/` (gitignore 対象) にある。

## 前提: 当時の再生経路

```
受信: datagram / subgroup -> 復号前遅延 -> AudioDecoder (Opus / AAC) -> AudioData (20 ms)
予約: AudioBufferSourceNode を 1 フレームに 1 つ作り、source.start(when) で連結
      (通常のフレーム境界にフェードは無い)
加工: 遅れは compressSamples でピッチ周期 1 つ分を削る (時間圧縮)
      欠落は concealSamples で直前の音の周期を繰り返して埋める (補間)
出力: AudioContext -> MediaStreamAudioDestinationNode -> MediaStream
      -> アプリの <audio> / <video> (devtools は setSinkId で出力デバイスを選ぶ) -> OS / デバイス
```

- ライブラリは **復号フレームのレートに合わせた `AudioContext`** を作る。Opus は Catalog の
  `samplerate` に関係なく 48 kHz、AAC は Catalog の `samplerate` である
  (`src/codec/config.ts` の `resolveAudioContextSampleRate`、`src/createMediaSubscriber.ts` の
  `createOutputStream`)。devtools の再生も購読開始時に同じ値を決め、その値で
  `AudioContext` を作る (`devtools/src/hooks/useSubscriber.ts` /
  `devtools/src/hooks/audioPlaybackController.ts`)。これは 2026-10-27 の修正で入った
- 再生する `AudioBuffer` は **復号した `AudioData.sampleRate`** で作る
  (`src/playout/audioPlayoutSession.ts` の `startBuffer` の `createBuffer`)。上の修正で
  AudioContext のレートとバッファのレートは一致する。崩れた場合は
  `playoutTiming.sampleRateMismatchFrames` に現れる
- **Chromium の Opus 復号は、configure した `sampleRate` に関係なく常に 48 kHz / 960 フレームを
  返す** (WebCodecs で実測)。AAC の復号レートは AudioSpecificConfig に従う
- 計器 (`AudioReceiverStats.playoutTiming`) が見るのは **AudioContext への予約時刻まで**である。
  `MediaStream` を `HTMLAudioElement` で再生した後のバッファ、出力デバイスの遅延、Bluetooth の
  遅延は含まない (`docs/HIGH_LEVEL_API.md` 1102 行付近、`devtools/src/components/statsHelp.ts`)
- 時間圧縮が動くのは「遅れが 20 ms 以上」かつ「キューの余裕が正」のときだけである
  (`src/playout/audioPlayout.ts` の `schedule` の圧縮条件)。音声だけの購読は到着基準で並べるため圧縮しない
  (`scheduleByArrival` は `compressSeconds: 0` を返す)
- 時間圧縮と補間は 8 / 16 / 32 / 48 kHz と 44.1 kHz に対応する。24 / 22.05 / 88.2 / 96 kHz
  などでは何もしない (`src/playout/audioTimeStretch.ts:97-102`)

## 結論: 症状別の候補一覧

### 症状 A (ジジジ) の候補

| #   | 候補                                                                      | 確度                    | 起きる条件                                                                                                                                             | 根拠                                                                                                                                                                       | 既存の計器                            |
| --- | ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A1  | サンプルレート不一致による 20 ms ごとの 1 サンプル重なり                  | **高 (機序。修正済み)** | 修正前は AudioContext が 44.1 / 88.2 / 22.05 kHz で復号フレームが 48 kHz のとき。OS の既定出力が 44.1 kHz の devtools、または Catalog が 44100 の Opus | 実測: 99/99 境界で重なり、振幅 2 倍 (+6 dB) が毎秒 50 回。声で 50 Hz 側波帯が最大 −35.5 dBc。`src/playout/audioPlayoutSession.ts:917`、`src/createMediaSubscriber.ts:1935` | `sampleRateMismatchFrames` (追加済み) |
| A2  | 時間圧縮の 4 kHz 格子量子化による粗さ                                     | 中〜高 (一部修正済み)   | 映像も購読していて、目標 (表示時刻) が前へ動く / 押し直しが続き、圧縮が毎秒数回以上動くとき                                                            | 圧縮は周期を 12 サンプル格子へ丸める (`src/playout/audioTimeStretch.ts` の `analyze` / `refineLag`)。毎フレーム圧縮で 50 Hz 側波帯 −25〜−30 dBc、非調和成分 −10.8〜−14 dB  | 量のみ (`compressedMs`)               |
| A3  | 圧縮後の補間失敗 (増幅要因。圧縮単独では穴はできない)                     | 低〜中                  | 別の原因 (到着の揺らぎ / 目標の上昇 / 停止) で隙間が空き、直前のフレームが圧縮されていたとき (F0 約 130〜195 Hz)                                       | 実装の `AudioPlayoutScheduler` 直接駆動では圧縮 9 フレーム連続でも穴 0。穴が空いた場合だけ `previousChannels = stretched.channels` の解析窓が縮み補間が失敗する            | `gapCount` / `gapMs`                  |
| A4  | 目標上昇局面の「穴 + 2 ms ヘッドフェード」                                | 中 (条件限定)           | 目標が 1 ms/フレーム以上で後ろへ動き続けるとき。jitter 推定の上昇、閉ループ目標の増加、適応上限 100→160 ms                                             | 毎フレーム 2 ms フェードで 50 Hz 変調 −13.3 dBc (実測)。上昇中は 50/50 フレームで穴                                                                                        | `gapCount`                            |
| A5  | 16 kHz の AudioContext に 48 kHz の広帯域音を鳴らす折り返し               | 中                      | BT が HFP で OS 既定出力になり、AudioContext が 16 kHz になる一方、購読音声が通常の 48 kHz マイク由来のとき                                            | 48 kHz → 16 kHz の間引きにアンチエイリアスが無く、10 kHz が 6 kHz へ振幅そのまま折り返す (実測)                                                                            | 不可                                  |
| A6  | playout 以外 (配信側の AEC / NS / AGC、Opus ビットレート、パケロス、下流) | 低〜中                  | devtools のマイク処理は既定で AEC / NS / AGC が ON、ビットレートは既定 64000 bps                                                                       | `devtools/src/signals/connectionSettings.ts:303-316`。ジジジ寄りの AGC / NS アーティファクトは BT マイクで増え得る (推測)                                                  | なし                                  |

A1 が今回の調査で見つかった新しい機序であり、症状 A の最有力候補である。A2 は
サンプルレートがすべて 48 kHz の通常環境でも起きる。A3 は圧縮単独ではなく、別の原因で
空いた穴を無音として残しやすくする増幅要因である。A1 から A5 と B1 から B4 はすべて
ローカルで起きるため、回線が良好でも発生する。

### 症状 B (プツプツ) の候補

| #   | 候補                                                             | 確度         | 起きる条件                                                                                       | 根拠                                                                                            | 既存の計器                 |
| --- | ---------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | -------------------------- |
| B1  | Bluetooth の HFP 切替 + 二段構成 + BT リンク                     | 高 (BT 固有) | BT ヘッドセット 1 台で入出力同時、または BT が OS 既定出力。A2DP ↔ HFP の切替、SCO / A2DP の競合 | Microsoft Learn、SDL #8192、Chromium issue 41348896、WebKit 241223 / 248592 (BT の glitch 実例) | 不可                       |
| B2  | 圧縮後フレームの補間失敗 (A3 と同じ増幅要因。単独では起きない)   | 低〜中       | 別の原因で穴が空いたとき。圧縮だけでは穴はできない                                               | 圧縮 9 フレーム連続でも穴 0 (実装直接駆動)。穴が空いた場合に 5.5〜7.3 ms の無音になり得る       | `gapCount`                 |
| B3  | サンプルレート不一致のクリック列 (A1 と同じ)                     | 高 (機序)    | AudioContext が 44.1 kHz になるとき (OS 既定出力が 44.1 kHz の BT A2DP 等)                       | 実測: 毎秒 50 回の広帯域クリック                                                                | 不可                       |
| B4  | AudioContext の suspend / resume、デバイス切替                   | 中           | BT の接続 / 切断、既定出力の変更、Safari の interrupted                                          | 実測: 500 ms 停止で 13 フレーム / 260 ms を backlog 破棄、314.7 ms の無音と 0.256 の段差        | 部分的                     |
| B5  | 既知の穴 / 境界の段差 / 押し直し                                 | 中 (既知)    | 到着の揺らぎが目標遅延を超える、メインスレッドの停止                                             | `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`                                                           | あり                       |
| B6  | 時間圧縮 / 補間が使えないレート                                  | 低           | AAC の 24 kHz、96 kHz など                                                                       | `src/playout/audioTimeStretch.ts:97-102`。穴が無音のまま残る                                    | `stretchUnavailableFrames` |
| B7  | HTMLMediaElement 以降の下流 (要素のバッファ、setSinkId 経路、BT) | 未計測       | すべての `<audio>` / `<video>` 再生。特に BT                                                     | 計器は AudioContext の予約まで。要素の `waiting` / `stalled`、BT の再バッファは JS から見えない | 不可                       |

## 最初に見るべき 1 点

症状 A / B のどちらでも、**購読側の `AudioContext.sampleRate` と、復号フレームの
`AudioData.sampleRate` を比較する**のが最短の切り分けである。両者が違えば A1 / B3 の機序が
働いている。44.1 kHz の AudioContext に 48 kHz の Opus フレームなら確定である。

2026-10-27 の修正で、`AudioReceiverStats.playoutTiming` に `sampleRateMismatchFrames` /
`contextSampleRate` / `decodedSampleRate` を追加した。`sampleRateMismatchFrames` が 0 より
大きければ、この機序が働いている。修正前の `boundaryStepCount` は予約したサンプル列の
段差しか見ないため、この現象を 1 件も数えなかった (実測: 114 個の重なりがあるセッションで
`boundaryStepCount` は 3)。

## 詳細

### A1. サンプルレート不一致による 20 ms ごとの 1 サンプル重なり (最有力)

**機序**

1. ブラウザの `AudioBufferSourceNode` は、バッファのサンプルレートが AudioContext の
   サンプルレートと違うとき、バッファごとにリサンプルする。このとき Chromium 156 は、
   20 ms のバッファの出力を公称より 1 サンプル長くレンダリングする組み合わせがある。
2. 次のフレームは公称どおり 20 ms 後に開始するため、**前のフレームの余分な 1 サンプルと
   次のフレームの先頭が同じサンプル位置で足し合わされる**。振幅が約 2 倍 (+6 dB) に
   なるスパイクが、毎秒 50 回入る。
3. これは「位相の飛び」ではない。DC 0.5 のバッファを並べると、境界のサンプルだけが 1.0
   (0.5 + 0.5) になることで確認できる。

**実測 (実 Chromium 156)**

| 条件                           | 20 ms 境界の重なり | 440 Hz の残差 | 境界の実効段差 / ピーク | クリック判定 |
| ------------------------------ | ------------------ | ------------- | ----------------------- | ------------ |
| Context 48000 / バッファ 48000 | 0 / 99             | −153.3 dBc    | 0.3 %                   | 0            |
| Context 44100 / バッファ 48000 | **99 / 99**        | **−29.4 dBc** | **100.4 %**             | **80 / 99**  |
| Context 48000 / バッファ 16000 | **97 / 99**        | −29.6 dBc     | 101.0 %                 | 79 / 99      |
| Context 16000 / バッファ 48000 | 0 / 99             | −153.8 dBc    | 3.0 %                   | 0            |

- 声に近い信号 (120 Hz + 40 倍音) では、境界の残差がピークの 49.9 %、元波形との残差が
  −32.7 dBc だった
- 実時間の `AudioContext` でも 99/99 で同じ結果だった。`MediaStreamAudioDestinationNode` の
  トラックにも、要素へ渡る時点で 50 フレーム中 49 境界の重なりが存在した
- 440 Hz では 50 Hz の線スペクトルは弱い (−164.9 dBc)。重なりの極性が 5 フレーム周期で
  打ち消されるためである。耳には「50 Hz のブザー」ではなく、**毎秒 50 回の広帯域クリック列**
  (声ではざらつき) として乗ると解釈している。実際の聞こえ方は未確認である

**修正前に到達した条件 (実測とコード)**

- devtools: `new AudioContext()` のレートは「出力デバイスの preferred sample rate」だった
  (MDN)。**OS の既定出力デバイス**が 44.1 kHz のとき (USB DAC、一部の内蔵出力、
  Bluetooth A2DP のスピーカーなど) に成立した。devtools の Output で 44.1 kHz の BT を
  選んでも、AudioContext の既定出力が 48 kHz のままなら A1 は起きなかった (その場合は
  二段構成の別の問題になる)
- ライブラリ: AudioContext を Catalog の `samplerate` で作っていたため、**Catalog が 44100 の
  Opus** を購読すると、購読側のデバイスが 48 kHz でも必ず成立した。Chromium の Opus
  復号は 48 kHz 固定である。devtools の Sample Rate の選択肢は 8000 / 16000 / 24000 /
  48000 であり、devtools 経由では 44100 は作られないが、ライブラリ利用アプリでは作られ得た
- 修正後も、AAC の AudioSpecificConfig と Catalog の `samplerate` が食い違う場合や、
  AudioContext を作れず既定レートへフォールバックした場合は残り得る。その場合は計器に現れる
- 逆方向 (44.1 kHz のバッファを 48 kHz の Context で鳴らす) では重ならない (実測)
- 16000 / 24000 / 32000 / 8000 の Context に 48 kHz のバッファを並べる組み合わせでも
  重ならない (実測)。Bluetooth HFP の 16 kHz が理由でこのクリックが出るわけではない
- Chromium の実装依存である。バージョンやプラットフォームで変わり得る。Safari / Firefox は
  未測定である

**なぜ「話している間だけ」か**

無音のフレームは 0 + 0 = 0 であり、重なっても聞こえない。有声のフレームだけ、隣り合う
2 サンプルの和がスパイクとして出る。回線の状態とは無関係なので、「回線は良好なのに音が
悪い」という報告と整合する。

**確認方法 / 否定方法**

- 最短: `playoutTiming.sampleRateMismatchFrames` を見る。0 より大きければ、
  `contextSampleRate` / `decodedSampleRate` で組み合わせが分かる。修正前のコードで見る
  ときは、購読側で `AudioContext.sampleRate` と最初の数フレームの `AudioData.sampleRate` を
  ログに出す
- 波形: `MediaStreamAudioDestinationNode` の後ではなく、**source の出力 (MSD の入力) を直接**
  AudioWorklet で録り、20 ms ごとに 1 サンプルだけ 2 階差分が跳ぶ点を数える。MSD のストリームを
  同じ Context へ戻して録る方法 (既存の調査 spec) では、この現象を安定して数えられなかった
  (4 秒で 5 件 vs source 直接タップ 72 件)
- 否定: 両者が一致していればこの機序は働かない。48 / 96 / 32 / 24 / 16 kHz の Context では
  重なりは 0 と実測されている

**実装済み (2026-10-27)**

- `src/codec/config.ts` に `resolveAudioContextSampleRate(codec, catalogSampleRate)` を追加した。
  Opus は常に 48 kHz、AAC は Catalog の `samplerate` を返す
- ライブラリは `new AudioContext({ sampleRate })` と復号器の configure をこの値に揃えた
  (`src/createMediaSubscriber.ts`)。devtools も購読開始時に同じ値を決め、再生の AudioContext を
  その値で作る (`devtools/src/hooks/useSubscriber.ts` /
  `devtools/src/hooks/audioPlaybackController.ts`)。AudioContext を作れない環境では既定の
  レートへフォールバックする
- 計器 `sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` を追加した
- 単体テストで、Opus の Catalog 44100 → AudioContext / configure 48 kHz、AAC 44100 →
  AudioContext 44.1 kHz、計器の記録と reset を固定した
- 未確認: 実機の 44.1 kHz 出力デバイスで重なりが消えたかは、実ブラウザでの再測が必要である

### A2. 時間圧縮の 4 kHz 格子量子化による粗さ

**機序**

- 時間圧縮は、音の中央 (20 ms なら 10 ms) でピッチ周期 1 つ分を削り、切れ目の前後を
  線形クロスフェードして繋ぐ (`src/playout/audioTimeStretch.ts` の `compressSamples`)
- ピッチ周期は 4 kHz へ間引いた自己相関でラグ (10〜29) を探し、元のレートへ
  `Math.round(lag * samplesPer4kHzSample)` で戻す。**修正前は端数の補間が無かった**ため、
  周期は 48 kHz で 12 サンプル単位に量子化されていた。補間側の `findTailPeriod` は放物線補間で
  端数まで求めており、圧縮側だけ非対称だった。2026-10-27 に `refineLag` を追加して解消した
- そのため格子に乗らない F0 では、位相のずれた 2 区間をクロスフェードすることになり、
  非調和成分と 50 Hz の側波帯が増える

**実測 (合成信号、毎フレーム最大圧縮)**

| F0     | 4 kHz 格子との関係 | 50 Hz 側波帯 (中央値 / 最悪) | 高域包絡の 50 Hz 変調 | 非調和成分 |
| ------ | ------------------ | ---------------------------- | --------------------- | ---------- |
| 160 Hz | 格子に乗る         | −77.8 / −75.1 dBc (なし)     | 変化なし              | 変化なし   |
| 180 Hz | ずれる             | −29.7 / +19.3 dBc            | −41.1 dBc (元 −80.8)  | 増加       |
| 220 Hz | ずれる             | −32.3 / −15.5 dBc            | −36.7 dBc (元 −71.5)  | 増加       |
| 260 Hz | ずれる             | −24.8 / −19.8 dBc            | −38.6 dBc (元 −87.2)  | 増加       |

- 別の実験では、毎フレーム圧縮したときの非調和成分が声で −72.5 dB から
  −10.8〜−14.0 dB まで増えた
- 150 / 170 / 240 Hz では相関が 0.9 を下回り、圧縮を拒否したフレームと適用したフレームが
  混在する。同じ要求でも切る / 切らないが不規則になる。
- 圧縮の継ぎ目の「段差」自体は小さい (成功時の補間の継ぎ目段差は最大でピークの 6.4 %)。
  耳につくのは段差よりも、この格子誤差による濁りである

**圧縮が動く条件 (現行コード)**

- `queueSlack > 0` かつ `lateness >= 20 ms` のときだけ圧縮する。アンダーラン中は
  `queueSlack <= 0` なので圧縮しない
- 到着の揺らぎだけでは圧縮しない。実測の到着列と静的目標で `AudioPlayoutScheduler` を
  60 秒駆動して、圧縮は 0〜1 回 (5.25 ms) だった。**到着の尾はアンダーラン (穴) になり、
  圧縮にはならない**。既存の `docs/AUDIO_PLAYOUT_LATENCY.md` の「到着の尾 → 圧縮」の
  因果は、現行コードでは再検証が必要である
- 圧縮が続くには「目標が前へ動く」か「押し直し (`pushStart`) が続く」ことが要る。
  目標が前へ動く源は、A/V 同期の減衰 (20 ms/秒)、適応上限の 160 → 100 ms 復帰、
  閉ループ目標の減少 (10 ms/秒) である
- 実リレーの実測では圧縮が 3〜26 ms/秒 (60 秒で 556〜996 ms) 続いていた。
  1 回の圧縮で 2.5〜10 ms 削れるから、毎秒 1〜5 回の圧縮に相当する。
  話している間は粗さが途切れない状態になり得る

**確認方法 / 否定方法**

- 計器だけで一部可能: `compressionMsPerSecond` が正の区間と、`appliedMs` /
  `appliedCeilingMs` / `avSync.delays.*.syncExtraDelayMs` の減少が時間的に一致するかを見る。
  一致しなければ `pushStartCount` を疑う
- 波形: source の出力を録り、4〜8 kHz 帯の振幅包絡の 50 Hz / 100 Hz 成分を測る。
  `compressedMs` の増加区間と一致するかを見る
- 否定: 圧縮が 0 の区間でも 50 Hz 変調が出るなら A1 か A4。F0 が 160 / 200 Hz のような
  格子に乗る声ではこの機序は出ない

**実装済み (2026-10-27)**

- `compressSamples` の周期推定に、ピーク前後 1 格子の相関による放物線補間を入れた
  (`src/playout/audioTimeStretch.ts` の `refineLag`)。補間側の `findTailPeriod` と同じ考え方で、
  圧縮側だけ格子のままだった非対称を解消した。完全相関の整数周期は動かさない
- 実測した削る長さ (48 kHz、20 ms フレーム): 180 Hz 264 → 267 (真 266.667)、
  220 Hz 216 → 218 (真 218.182)、260 Hz 180 → 184 (真 184.615)、
  44.1 kHz 300 Hz 143 → 147 (真 147)
- 150 / 170 / 240 Hz は格子誤差で相関が 0.9 を下回り「圧縮する / しない」が不規則だったが、
  周期が正確になり全フレームで適用されるようになった
- 160 / 200 Hz のような格子に乗る F0 は従来どおり完全一致のままである
- 未確認: 実音声での粗さの改善量と、圧縮の適用率が上がったことによる聴感の変化

### A3 / B2. 圧縮後の補間失敗 (増幅要因。圧縮単独では穴はできない)

**まず否定: 時間圧縮そのものは隙間を作らない**

- 圧縮は `queueSlack > 0` かつ `lateness >= 20 ms` のときだけ要求される
  (`src/playout/audioPlayout.ts:546-562`)
- `queueSlack > 0` は `previousEnd > now + minLead` を意味する。開始時刻は
  `startAt = max(target, now + minLead, previousEnd)` であり、`startAt = target` なら
  `lateness = 0` で圧縮は要求されない。したがって圧縮されるときは `startAt = previousEnd`
  であり、そのフレームの隙間 (`startAt - previousEnd`) は 0 である
- 次のフレームも、削った分は lateness を減らす向きに働き、開始は `previousEnd` に張り付く。
  ここでも隙間は 0 になる
- 実装の `AudioPlayoutScheduler` を直接駆動して確認した。100 ms 先までキューを伸ばした後、
  目標を 150 ms 前へジャンプさせた 60 フレームのうち、10〜18 の 9 フレームで 10 ms の
  圧縮が要求され、**そのすべてで `gapSeconds` は 0** だった
- したがって「圧縮したフレームの後ろに隙間ができ、その補間が失敗して無音になる」という
  経路は通常は通らない。合成モデルで圧縮を条件無視で強制した実験 (`experiments.md` の
  `compress_library`) の 100 個の穴は、実セッションに到達可能な値ではない
  (`investigation-logs/glitch-2026-10-27/CORRECTION.md`)

**残る性質: 別の原因で隙間が空いたときの増幅**

- 隙間が空く原因は、到着の揺らぎ、目標の上昇、停止などである (A4 / B5)
- そのとき直前のフレームが圧縮されていれば、`playSound` が
  `this.previousChannels = stretched.channels` とするため
  (`src/playout/audioPlayoutSession.ts` の `playSound` の `previousChannels = stretched.channels`)、**圧縮後の短いフレーム**から周期を探すことになる
- 4 kHz 解析のラグ上限は「間引き後の長さ − 相関窓 39」で縮む。圧縮後のフレームが
  612〜744 サンプル (12.75〜15.5 ms) になると、F0 約 130〜195 Hz の周期を探索できない
  (実測: 該当 14 例すべて失敗)
- 補間が失敗すると、その隙間は無音のまま残り、境界に段差が出る。つまり
  **「別の原因で穴が空き、かつ直前のフレームが圧縮されていた」場合だけ**、穴が無音として
  残りやすい、という増幅要因である
- 頻度は「圧縮の頻度」と「穴の頻度」の積で決まる。「圧縮が数回/秒あるので穴も数回/秒」と
  いう見積もりは誤りである

**確認方法 / 否定方法**

- `compressedMs` が増えているフレームの直後に `gapCount` / `gapMs` が増えているかを見る。
  増えていても、穴の原因は到着か目標の変化である
- 波形: 穴の直前のフレームが圧縮されていたかを `compressedMs` の増分と対応づける
- 否定: 圧縮だけを起こして到着と目標を一定にすると穴は 0 になる (実装の直接駆動で確認)

**改善の方向 (実装はしない)**

- 圧縮前のフレームで求めたピッチ周期を保持し、補間はその周期で行う
  (補間の解析窓を短くしない)
- 補間できない穴は 2 ms フェードで消す (段差を減らす)
- 圧縮の増分と穴の増分を対応づける計器を足す

### A4. 目標上昇局面の「穴 + 2 ms ヘッドフェード」

- 目標 (表示時刻) が後ろへ Δ 動くと、前の音の終わりと今回の開始の間に Δ の隙間ができる。
  0.5 ms を超える隙間は補間され、補間の末尾 2 ms と実音の先頭 2 ms が 0 へ落ちる
  (`src/playout/audioPlayoutSession.ts` の `playSound` の補間末尾と実音先頭の 2 ms フェード)
- 1 ms/フレーム以上で目標が上昇すると、上昇区間の 50/50 フレームで穴 + フェードになる (実測)
- 2 ms / 20 ms = 10 % の周期振幅変調であり、50 Hz 変調は −13.3 dBc (フェードなし −66.4 dBc)
- 上昇が 1 回の段差 (適応上限 100 → 160 ms の 60 ms など) なら、1 回の繰り返し音と段差に
  なり「プツプツ」寄りである
- 通常の jitter 推定の上昇は数 ms/フレーム以下であり、恒常化するのは異常な局面だけである。
  実装後の実リレーの収録では `gapCount` 21 / 60 秒であり、フェードも 21 回程度に留まった
- この状態では `startAt = target` なので `lateness = 0` になり、時間圧縮は要求されない。
  A2 と A4 は同じフレームでは同時に起きない

### A5. 16 kHz の AudioContext に 48 kHz の広帯域音を鳴らす折り返し

- 48 kHz のバッファを 16 kHz の Context で鳴らすと、Chromium の線形補間の間引きには
  アンチエイリアスが無いため、8 kHz を超える内容が同じ振幅で折り返す
  (10 kHz → 6 kHz、振幅 0.5 のまま。実測)
- 起きる条件は「Context が 16 kHz で、バッファに 8 kHz 超の内容がある」ときである
- **A1 の修正後、Opus の AudioContext は常に 48 kHz で作るため、主経路では起きない。**
  BT が HFP で 16 kHz の出力デバイスになっても、Chromium が AudioContext の出力を
  状態を保ったままデバイスへ変換する。AAC で Catalog が 16 kHz のときは、AudioContext と
  復号フレームの両方が 16 kHz になり、内容も 8 kHz 以下なので折り返さない
- 残るのは、AudioContext の生成が `sampleRate` 指定に失敗して既定レートへフォールバック
  した場合や、ブラウザが Opus の復号出力を 48 kHz 以外にする場合である。そのときは
  `sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` に現れる
- 16 kHz では 1 レンダリング量子 (128 フレーム) が 8 ms になり、playout の余裕
  (`AUDIO_PLAYOUT_MIN_LEAD_SECONDS` = 10 ms、押し直し 3 ms) が 48 kHz 前提のままになる。
  予約の押し直しや余裕の前提が崩れる可能性がある (未検証)

### B1. Bluetooth 固有の候補

Bluetooth 実機は無いため、コード経路の解析と一次情報で整理した。詳細は
`investigation-logs/glitch-2026-10-27/bluetooth.md` にある。

1. **同一 BT デバイスの双方向利用による HFP 切替 (確度: 高)**。マイクを開くと OS が
   A2DP から HFP (8 / 16 kHz モノラル) へ切り替え、出力経路が再構成される。切替の瞬間に
   全アプリで一時的な途切れが出る。Windows 10 では A2DP へのストリーミングが破棄される。
   macOS では出力が 44.1 kHz ステレオから 16 kHz モノラルへ落ちる実測がある (SDL #8192)。
   HFP 動作中は SCO の予約スロット競合で周期的なアンダーランが起きやすい
2. **二段構成のクロック / リバッファリング不一致 (確度: 中)**。AudioContext は OS 既定出力で
   動き、実際に鳴るのは `<audio>` の `setSinkId` 先の BT デバイスである。2 つのクロック差を
   吸収する仕組みは無い。Chromium の `WebAudioMediaStreamSource` は 10 ms 単位にリバッファし、
   実装コメントに `TODO(crbug.com/1302080): this should use the actual audio playout stamp
   instead of Now()` とある。クロック差が溜まると要素側でアンダーラン (無音挿入) が
   周期的に起きる (推測)
3. **BT リンク / OS オーディオスタック (確度: 中)**。A2DP の再送、SCO との予約スロット競合、
   OS のバッファ枯渇で、アプリとは独立に無音が挟まる。Chromium issue 41348896 (BT で
   Web Audio が glitch、FIFO アンダーラン)、WebKit 241223 / 248592 (出力デバイス切替や
   BT イヤホンで Web Audio のレンダリングが壊れる。2022 年に修正) がある
4. **AudioContext の interruption / suspend 監視 (確度: 中低)**。BT の接続 / 切断、
   他アプリの排他で Context が中断すると、予約済みの音が飛ぶ / 復帰時に段差になる。
   2026-10-27 に devtools で `statechange` を監視し、状態と回数・警告を出すようにした
   (`audioContextNotRunning`)。ライブラリ側は未対応のままで、自動 resume もしていない
5. **setSinkId の切替 / 抜き差し (確度: 低)**。出力選択の変更や BT 切断のたびに再ルーティング
   され、クリックや無音が起きる。切断後に古いデバイスを指したままになる既知の挙動がある
6. **AEC / NS / AGC との組み合わせ (確度: 低)**。devtools の既定は 3 つとも ON で、BT マイクを
   開くこと自体が HFP 切替の引き金になる。NS / AGC のアーティファクトはジジジ寄りである

### B4. AudioContext の停止と復帰 (状態変化)

- 実測: 500 ms の suspend で、13 フレーム / 260 ms が `backlog` として破棄された。
  復帰の前後に 314.7 ms のデジタル無音と 0.256 の段差 (クリック) が出た
- 停止中は `currentTime` が止まる一方で壁時計と TIMESTAMP は進む。目標が
  `now + 上限` を超えると `backlog` として破棄する (`src/playout/audioPlayout.ts` の `schedule` の backlog 判定)
- 復帰直後は `getOutputTimestamp()` が `performanceTime: 0` を返し、時計の対応を
  取り直す (`src/playout/audioPlayoutSession.ts` の `handleDecodedAudio` の時計対応)。`AUDIO_CLOCK_STALL_MS` = 250 ms の
  停止検出はあるが、停止中に返る古い対応はそのまま取り直す
- 起きる環境: BT の接続 / 切断、既定出力の変更、Safari の interrupted、自動再生ポリシーで
  resume が遅れたとき。実機で AudioContext が実際に suspend するかは未検証である

### B5 / B6. 既知の穴と非対応レート

- 既知: 到着の揺らぎが目標遅延を超えると無音の穴ができ、境界に段差が残る。押し直し
  (`pushStart`) では前の音の末尾がフェードされないため段差が残り得る。詳細は
  `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`
- 時間圧縮 / 補間が使えないレート (24 / 22.05 / 88.2 / 96 kHz など) では、遅れが戻らず、
  欠落が無音のまま残る (`stretchUnavailableFrames`)。44.1 kHz は現在は対応している
  (`docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md` の「44.1 kHz は非対応」という記述は古い)

### B7. HTMLMediaElement 以降 (未計測)

- 音は AudioContext の `destination` ではなく、`MediaStreamAudioDestinationNode` のトラックを
  `<audio>` / `<video>` の `srcObject` に設定して鳴らす。devtools は `setSinkId` で出力先を選ぶ
- 要素のバッファ、サンプルレート変換、出力デバイスの遅延、BT の再バッファは JS から
  観測できない。計器が 0 のまま聴感で切れるなら、この層か BT を疑う
- 2026-10-27 に devtools へ次の診断を追加した。BT の切り分けに使う
  - AudioContext の `state` / statechange 回数 / サンプルレート
  - `<audio>` の `waiting` / `stalled` / `error` の累積回数
  - `audioContextNotRunning` (running 以外が 2 秒以上) / `audioContextNarrowband`
    (8 / 16 kHz の Context) / `audioSampleRateMismatch` の警告
  - 表示は Audio Playback の Output セクションと Warnings セクション
- 要素へ渡る時点で A1 の重なりは既に存在する (実測)。要素の後段で新たな不連続が乗るかは
  未測定である

## 否定できたこと / 既知の誤解

- **128 フレームのレンダリング量子による `start(when)` の量子化**: 起きない。`start(when)` は
  サンプル単位で切り上げられ、量子境界へは丸められない (実測。127.5 → 128、量子 128 とは
  無関係)
- **通常の 20 ms フレーム境界の不連続**: 同一レートでは起きない。48 kHz context に 48 kHz の
  バッファを並べた出力は、1 本の長いバッファの出力と最大差 6.3e-14 で一致した。
  「通常境界にフェードを入れない」設計自体は正しい
- **押し直しの積み重ねによる重なり (コムフィルタ)**: 起きない。`shiftPlayoutEnd` で次の音の
  下限も同じだけ遅らせるため、重ならず「切れた末尾 + 短い無音」になる
- **予約時刻の端数がそのまま段差になる**: 同一レートでは否定。端数がフレーム間で同じなら
  切り上げで吸収される。フレームごとに切り上げ結果が変わるときだけクリックになる
- **44.1 kHz の音声を 48 kHz の Context で鳴らす場合**: 重ならない (実測。AAC 44.1 kHz を
  48 kHz の devtools で鳴らす場合は A1 に該当しない)
- **Bluetooth HFP マイクの 16 kHz がレート不一致クリックの原因**: 否定。16000 / 48000 は
  重なり 0 / 99。ただし 16 kHz 符号化でない広帯域音を 16 kHz の Context で鳴らす場合は
  折り返しが起きる (A5)
- **クリッピング / DC / チャンネル取り違え**: playout の加工は凸結合とコピーだけで、振幅を
  増やす経路は無い。50 Hz の周期性も作らない
- **時間圧縮の継ぎ目のクリック**: 段差としては小さい (成功時の継ぎ目段差は最大でピークの
  6.4 %)。粗さは A2 の格子誤差の領分である
- **「50 Hz の連続ブザー」**: 440 Hz の純音では 50 Hz の線スペクトルは −164.9 dBc で弱い。
  A1 は「毎秒 50 回の広帯域クリック列」と解釈するのが妥当である (聴感は未確認)

## 旧実装での切り分け手順

実機の症状を 1 つずつ消していくための順序である。BT 実機が無くても一部は実施できる。

### 1. 環境を記録する

ブラウザとバージョン、OS、devtools かライブラリか、BT 機器の型番、出力デバイスの指定方法
(OS 既定 / devtools の Output / アプリの `setSinkId`)、入出力の組み合わせ、Sample Rate、
Channels、AEC / NS / AGC、Catalog の `samplerate`、症状の周期を記録する。
追加で聞くべき情報の一覧は `investigation-logs/glitch-2026-10-27/bluetooth.md` の §6 にある。

### 2. レートの不一致を確認する (最重要)

- 購読側の `AudioContext.sampleRate` と `AudioData.sampleRate` を比較する。
  44.1 kHz と 48 kHz の組み合わせなら A1 / B3 がほぼ確定する
- `playoutTiming.sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` を
  見る (2026-10-27 に追加した)
- レートは AudioContext の**既定出力デバイス**で決まる。devtools の Output (`setSinkId`) を
  変えても AudioContext のレートは変わらないことに注意する

### 3. playout 側か下流 (HTMLMediaElement / BT) かを分ける

devtools の Subscriber 統計 (Copy for LLM) を取る。

- `playoutTiming.gapCount` / `gapMs` / `unrecoverableGapCount`
- `playoutTiming.boundaryStepCount` / `boundaryStepMax`
- `playoutTiming.lateStartCount` / `pushStartCount` / `pushStartMaxMs`
- `playoutTiming.stretchUnavailableFrames`、`compressedMs`、`concealedMs`
- `avSync.audioClockFallback`、`stallCount` / `stallMs`

判定:

- 計器に穴 / 段差 / 押し直しが出ている -> playout 側の既知の機序 (B5) を先に疑う
- 計器が 0 のまま聴感で切れる -> 下流 (B1 / B7) を疑う
- `gapCount` がフレーム数に近いのに `compressedMs` が増えない -> A4
- `compressedMs` の直後に `gapCount` が増える -> 穴の原因は別 (到着 / 目標 / 停止)。直前が圧縮フレームだと補間が失敗しやすい (A3)
- `audioClockFallback` が true -> `getOutputTimestamp` が使えず、出力遅延なしで予約している

### 4. 44.1 kHz 仮説の A/B

- OS の既定出力デバイスを 48 kHz 固定にする (macOS は Audio MIDI 設定)。BT A2DP の 44.1 kHz と
  内蔵 48 kHz を既定出力として切り替える
- 音が変われば A1 / B3。修正後は AudioContext が復号レートに揃っているため、
  `sampleRateMismatchFrames` が 0 のままかを見る

### 5. 時間圧縮仮説の A/B

- 音声トラックだけを購読する構成にできるなら、その構成で試す。音声だけの再生は到着基準で
  並べるため時間圧縮が 0 になる (`scheduleByArrival`)。粗さが消えれば A2 / A3 が濃厚
- `compressedMs` / `compressionMsPerSecond` と `appliedMs` / `appliedCeilingMs` /
  `syncExtraDelayMs` の減少の同時性を見る

### 6. Bluetooth の A/B

1. すべて有線 (マイク・スピーカー)
2. BT マイク + 有線スピーカー
3. 有線マイク + BT スピーカー
4. BT 1 台で双方向
5. OS 既定出力 = BT、devtools の Output = Default
6. OS 既定出力 = 内蔵、devtools の Output = BT
7. Sample Rate を 48 kHz / 16 kHz で比較
8. AEC / NS / AGC を個別に ON / OFF

双方向のときだけ悪化すれば HFP 切替 (B1)。OS 既定と Output が違うときだけ悪化すれば
二段構成 (B1 の 2 番目)。Output を Default に戻すと消えれば二段構成である。

### 7. 下流の確認

- OS のループバック録音 (macOS は BlackHole 等、Windows は WASAPI ループバック) で、
  BT へ実際に出た音を録り、無音の穴の周期と長さを測る
- 同じ BT 機器で YouTube 等の他アプリを再生して比較する
- `<audio>` の `waiting` / `stalled` の回数と、`<audio>.currentTime` と
  `AudioContext.currentTime` の差を記録する
- `chrome://media-internals` を補助的に見る

## 追加で必要な情報

1. ブラウザ名とバージョン、OS 名とバージョン
2. devtools かライブラリか。ライブラリなら再生に使っている要素、`setSinkId` の有無、
   `AudioContext` の作り方
3. BT 機器の型番と接続方式 (Classic / LE Audio)。同じ機器をマイクとスピーカーの両方に
   使っているか
4. 入出力の組み合わせ (BT マイク + BT スピーカー / BT マイク + 内蔵 / 内蔵 + BT / 有線)
5. 出力デバイスの指定方法 (OS 既定 / devtools の Output / アプリの `setSinkId`)
6. devtools の Sample Rate / Channels / AEC / NS / AGC と、Catalog の `samplerate`
7. 症状は連続か周期的か。周期が分かるか。操作 (配信開始 / 停止 / デバイス切替) のときだけか。
   話しているときだけか
8. プツプツは自分の配信を購読した自分の声か、遠隔の相手の声か
9. 有線にすると直るか。同じ BT 機器で他アプリは切れないか
10. 通話 / 会議アプリの同時利用、ドングル、距離、干渉源
11. できれば devtools の統計 (Copy for LLM) と、症状時の録音

## 当時の計器と修正の方向性

計器の追加候補:

1. `sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` (A1 の検出。実装済み)
2. 出力の実波形タップ (`outputStepCount` / `outputSilenceMs`)。source の出力 (MSD の入力) を
   AudioWorklet で録り、2 階差分とデジタル無音を数える。A1 / A2 / A3 を同じ計器で捕まえられる
3. `headFadeCount` と `gapCount` / `compressedMs` の同時記録 (A3 / A4 の切り分け)
4. `contextStateChanges` / `suspendedMs` と `<audio>` の `waiting` / `stalled` (B4 / B7)
5. `AudioClockBridge` の offset 段差と `outputLatency` の変化 (B4)

修正の方向性 (設計判断は別途):

- A1 / B3: AudioContext のレートを復号フレームのレートに合わせる (Opus は 48 kHz 固定)。
  または、フレームを予約前にステートフルなリサンプラで Context のレートへ変換する。
  devtools だけ既定レートで作っている非対称も解消する (実装済み)
- A2: `compressSamples` の周期推定に `findTailPeriod` と同じ放物線補間を入れる (実装済み)
- A3 / B2: 圧縮前のフレームで求めた周期を補間に使う、補間できない穴はフェードで消す
- B1 / B7: `AudioContext` の sink と `<audio>` の sink を一致させる、または二段構成をやめて
  `AudioContext.destination` へ直接つなぐ。`statechange` / `devicechange` を監視する
- B6 / A5: 非対応レート (24 / 22.05 / 88.2 / 96 kHz) の扱いと、16 kHz などの低い Context での
  折り返しの扱いを決める

## 実装した変更 (2026-10-27)

| 項目            | 内容                                                                                                                                      | ファイル                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 の修正       | AudioContext と復号器の configure を復号フレームのレートへ揃える。Opus は 48 kHz、AAC は Catalog の `samplerate`                          | `src/codec/config.ts` / `src/createMediaSubscriber.ts` / `devtools/src/hooks/useSubscriber.ts` / `devtools/src/hooks/audioPlaybackController.ts`                            |
| A1 の計器       | `sampleRateMismatchFrames` / `contextSampleRate` / `decodedSampleRate` を追加し、devtools の Audio Playback Timing にも出す               | `src/playout/audioPlayoutTimingStats.ts` / `src/playout/audioPlayoutSession.ts` / `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/components/statsHelp.ts`    |
| A2 の修正       | 圧縮側のピッチ周期推定に端数補間を入れる (`refineLag`)                                                                                    | `src/playout/audioTimeStretch.ts`                                                                                                                                           |
| A3 / B2 の扱い  | 圧縮単独では穴ができないことを確認し、増幅要因として記録した                                                                              | `investigation-logs/glitch-2026-10-27/CORRECTION.md`                                                                                                                        |
| B4 / B7 の診断  | AudioContext の state / statechange / サンプルレートと、`<audio>` の waiting / stalled / error を devtools に表示し、3 種の警告を追加した | `devtools/src/signals/subscriber.ts` / `devtools/src/utils/preconditionWarnings.ts` / `devtools/src/components/SubscriberPanel.tsx` / `devtools/src/hooks/useSubscriber.ts` |
| A1 の回帰テスト | 実ブラウザの 44.1 / 48 kHz の AudioContext でレート不一致計器の値を固定した                                                               | `tests/e2e/media-playout-rate-mismatch.spec.ts`                                                                                                                             |

- 単体テストは 251 ファイル / 4315 テスト成功。`tsc --noEmit` / `vp lint` / `vp fmt --check` も通る
- ローカルの実ブラウザ E2E (Chromium、実リレー無し): 164 件成功。新しいレート不一致の E2E
  (`tests/e2e/media-playout-rate-mismatch.spec.ts`) を含む
- 実リレー E2E: 26 件成功 / 11 件 skip / 0 件失敗。診断と警告を追加した後も `warnings=0` で
  回帰していないことを確認した
- A1 は実機の 44.1 kHz 出力デバイスでの聴感と `sampleRateMismatchFrames` をまだ測っていない。
  A2 は実音声での粗さの改善量をまだ測っていない
- A4 (目標上昇時の穴 + フェード)、A5 (16 kHz の折り返し)、B1 (Bluetooth の HFP / 二段構成) は
  未着手である

## 未確定 / 実機で確認が必要なこと

- **A1 の修正が実機で効いているかは未確認である。** devtools の AudioContext は購読開始時の
  解決値で作るようになったが、実機の 44.1 kHz 出力デバイスで重なりが消えたかは実ブラウザで
  確かめる必要がある。`sampleRateMismatchFrames` が 0 なら両者は揃っている。0 より大きければ
  この機序が残っている
- **1 サンプル余分にレンダリングされる挙動は Chromium 156 の実装依存である。** バージョンや
  プラットフォームで変わり得る。Safari / Firefox のリサンプラと、WebCodecs の Opus 復号が
  常に 48 kHz を返すかは未測定である
- **合成信号のみで測っている。** 実際の声 (Opus で復号した音声) での A2 / A3 の聞こえ方と
  頻度は未確認である。A3 は増幅要因であり、実セッションでの寄与は小さい見込みだが、
  「圧縮フレームの直後に空いた穴が無音で残るか」は実測する必要がある
- **実セッションで圧縮を持続させている源が、目標の後退なのか押し直しなのかは未計測である。**
  `compressionMsPerSecond` と `appliedMs` / `appliedCeilingMs` / `syncExtraDelayMs` /
  `pushStartCount` を同じ収録で突き合わせる必要がある
- **Bluetooth の候補 (B1) は実機で確認していない。** コード経路と一次情報から作った候補であり、
  HFP 切替の実害、二段構成のクロック差、BT リンクのアンダーランは実機の OS / デバイス依存である
- **HTMLMediaElement 以降の下流は測れていない。** 要素のバッファ、`setSinkId` の経路、
  Bluetooth の再バッファは JS から観測できない
- **A5 (16 kHz の Context への折り返し) が実機で起きる条件は未確認である。** HFP が OS 既定
  出力になったときに AudioContext が 16 kHz になるか、その環境で購読音声が広帯域かを確かめる
  必要がある
- **「ジジジ」「プツプツ」の解釈は推定である。** 候補と症状の対応は、統計と録音を突き合わせて
  確定する必要がある

## 付録: 調査の内訳と参照

| 担当           | 内容                                                 | ノート (gitignore 対象)                                  |
| -------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| signal-chain   | 時間圧縮 / 補間 / フェードの信号処理                 | `investigation-logs/glitch-2026-10-27/signal-chain.md`   |
| schedule-clock | 予約 / 時計 / 出力グラフ / レート不一致              | `investigation-logs/glitch-2026-10-27/schedule-clock.md` |
| bluetooth      | Bluetooth 固有 (HFP / 二段構成 / リンク / 状態変化)  | `investigation-logs/glitch-2026-10-27/bluetooth.md`      |
| experiments    | 実ブラウザ実験 (レート不一致 / 予約 / 圧縮 / 実時間) | `investigation-logs/glitch-2026-10-27/experiments.md`    |
| 訂正           | 圧縮単独では穴ができないことの確認 (A3 / B2)         | `investigation-logs/glitch-2026-10-27/CORRECTION.md`     |

主な一次情報:

- [MDN AudioContext()](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/AudioContext)
  (既定のサンプルレートは出力デバイスの preferred sample rate)
- [Web Audio API §2.5 / §2.6](https://webaudio.github.io/web-audio-api/#render-quantum-sizes)
  (レンダリング量子)
- [WPT PR 12887](https://github.com/web-platform-tests/wpt/pull/12887)
  (バッファ末尾の線形外挿によるリサンプル)
- [WebKit bug 241223](https://bugs.webkit.org/show_bug.cgi?id=241223)
  (出力デバイス切替で Web Audio のレンダリングが壊れる)
- [WebKit bug 248592](https://bugs.webkit.org/show_bug.cgi?id=248592)
  (AudioWorklet → MediaStream → `<audio>` で Bluetooth イヤホンだと glitch)
- [Chromium issue 41348896](https://issuetracker.google.com/issues/41348896)
  (Bluetooth で Web Audio が glitch、FIFO アンダーラン)
- [Microsoft Learn: Bluetooth Classic Audio](https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio)
  (A2DP は出力専用、マイクは HFP)
- [SDL issue #8192](https://github.com/libsdl-org/SDL/issues/8192)
  (macOS で BT マイク使用中は 44.1 kHz ステレオから 16 kHz モノラルへ落ちる)
- [Chromium webaudio_media_stream_source.cc](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/mediastream/webaudio_media_stream_source.cc)
  (10 ms リバッファ、`TODO(crbug.com/1302080)`)

既存のリポジトリ内の資料:

- `docs/AUDIO_PLAYOUT_GAPS_AND_TAIL.md`: 無音の穴と末尾の欠落の調査 (2026-10-20)
- `docs/AUDIO_PLAYOUT_LATENCY.md`: 遅延とノイズの再計測 (2026-10-16)
- `docs/AUDIO_PLAYOUT_RESULT.md`: 現状と既知の限界
- `docs/AV_SYNC_DECISIONS.md`: 決定と根拠
- `docs/AUDIO_DATAGRAM_ORDERING.md`: 到着順の逆転の計測
