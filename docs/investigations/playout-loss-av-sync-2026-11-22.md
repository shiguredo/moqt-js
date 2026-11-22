# パケット欠落時の A/V 同期: 現行コードの追跡

調査日: 2026-11-22。対象は moqt-js の `3da2a66ea90d839f0c2eae7ed866aa6b1840c712` と、ローカルの libwebrtc の `a17aec85c45e25561c5760f37c95b88f076af49f`。
「入力から出力まで」から「既存の検証と次の計測」までは上記のコミットの調査であり、行番号もその時点を指す。「実装後の課題」に変更と未検証の項目を追記した。

**調査時点の実装は音声の出力位置で欠落を補間するが、欠落中の媒体上の再生位置を映像側へ返していなかった。**
補間の成否、映像の進行、復帰後のずれは別々に評価する必要がある。過去の[再生の設計レビュー](../PLAYOUT_REDESIGN_REVIEW.md#L243-L251) が提案した媒体位置の追跡について、現行の通知がどこまで届くかを確認した。

## 入力から出力まで

1. **購読と復号。** SDK と DevTools はそれぞれ購読と復号を管理し、同じ [MediaPlayout](../../src/playout/mediaPlayout.ts#L402-L429) を使う。共有の時間軸が使うのは LOC の壁時計 TIMESTAMP。TIMESCALE ありの媒体時刻はマイクロ秒へ換算しても壁時計とは扱わず、時刻なしと同様に共通時刻での提示に使わない。[SDK の音声の復号入力](../../src/createMediaSubscriber.ts#L3136-L3170)、[音声の時間軸の判定](../../src/playout/audioPlayoutSession.ts#L351-L389)、[映像の時間軸の判定](../../src/playout/videoPlayoutSession.ts#L328-L348) を参照
2. **目標の提示時刻。** [共有時間軸](../../src/playout/timeline.ts#L630-L710) は、復号出力を受け取った時刻と TIMESTAMP の差の 10 秒最小を基準にし、直近 2 秒の遅れの分布を使う。音声の自動予算は揺らぎの百分位と出力先行量の p95 から決め、既定の下限は 50 ms、上限は 100 ms。catalog の `targetLatency` と同期の補償は別に扱う。音声のみ、または時間軸を無効にした場合は設定した `minDelayMs` の到着予算を使う。これらは最終出力までの遅延上限ではない。[音声予算の更新](../../src/playout/timeline.ts#L712-L763)、[適用条件](../../src/playout/mediaPlayout.ts#L653-L680)、[予約への反映](../../src/playout/audioPlayoutSession.ts#L392-L438)、[同期の補償と上限](../../src/playout/timeline.ts#L1750-L1806) を参照
3. **音声。** [AudioPlayoutScheduler](../../src/playout/audioPlayout.ts#L131-L247) が主スレッドで予約し、開始位置と加工後の長さを投入成功時に確定する。時間伸縮も投入前に行う。実 PCM と予約位置は [AudioOutputRenderer](../../src/playout/audioOutputRenderer.ts#L209-L242) が同じメッセージで送り、[AudioWorklet](../../src/playout/audioRenderProcessor.ts#L124-L161) が描画量子ごとに実音と欠落補間を処理する。Worker が復号する場合も、復号済みの入力から PCM を予約して Worklet へ渡す段は主スレッドに残る
4. **映像。** [PlayoutBuffer](../../src/playout/buffer.ts#L128-L211) は復号済みフレームを保持し、[表示周期](../../src/playout/videoPlayoutSession.ts#L395-L445) ごとに共有時間軸の目標に近いフレームを選ぶ。遅すぎるフレームを捨て、候補がなければ新しいフレームは出さない。DevTools の Canvas は提示遅延を 0 tick、SDK の既定の映像トラック経路は 1 tick と見積もる。[DevTools の接続](../../devtools/src/hooks/useSubscriber.ts#L1518-L1556)、[SDK の接続](../../src/createMediaSubscriber.ts#L955-L989) を参照

`preDecodeDelayMs` は [復号前の保持段](../../src/playout/preDecodeDelayStage.ts#L1-L19) を使う意図的な追加遅延であり、NetEq のように次に出す音を選ぶパケットバッファーではない。
SDK の [音声 Object の受信時刻](../../src/createMediaSubscriber.ts#L3034-L3044) は購読側コールバックの時刻であり、回線上の到着時刻ではない。この値と実際の保持時間は [復号器の追いつき判定](../../src/playout/audioReceiveCatchUp.ts#L341-L379) に使うが、共有時間軸の揺らぎの学習入力は復号後である。

## 欠落と観測の境界

- **媒体の欠落と出力の穴は別。** 既定の音声 Datagram の欠落は `MediaPlayout` に個別に通知されない。[受信の入口](../../src/createMediaSubscriber.ts#L3029-L3044) は重複を除き、届いた Object を後段へ渡す。raw Opus は[入力 TIMESTAMP の復元](../../src/codec/opusDecoderTimestamps.ts#L1-L12)によって復号後にも欠落による時刻の飛びを残す。飛びがあっても遅れた予約に吸収されて出力に穴がなければ、[AudioPlayoutSession](../../src/playout/audioPlayoutSession.ts#L586-L653) は欠落への対処として波形の継ぎ目だけを処理する。逆に、Object が失われていなくても、復号や Worklet への投入が締切に間に合わなければ、出力には穴ができる
- **音声の穴。** [AudioRenderConcealer](../../src/playout/audioRenderConcealer.ts#L195-L265) は出力サンプル位置に実音がなければ、直前の PCM から続き音を生成する。補間は通常最大 100 ms で、予測音を使い切った後は無音を出して未補間量に数える。実音には短いクロスフェードで復帰する。補間は失われた発話を復元する処理ではない。[補間器の入口](../../src/playout/audioRenderConcealer.ts#L107-L138)、[予測音の生成](../../src/playout/audioExpansion.ts#L156-L200) を参照
- **映像の欠落。** [VideoDecodeOrder](../../src/videoDecodeOrder.ts#L102-L134) は参照が欠けたと判断するとキーフレームを待つ。復号前に失った参照は表示キューでは回復できない。音声の穴と、映像が新しいフレームを提示できない時間は別に記録する

[音声の描画通知](../../src/playout/audioRenderQueue.ts#L98-L120) に媒体時刻が載るのは、対応情報のある実音ブロックの先頭を描画できたときだけである。
[Worklet のメッセージ](../../src/playout/audioRenderProcessor.ts#L148-L188) は 1,024 出力サンプル (48 kHz で約 21 ms) の間隔を基準に、最新の実音の観測を送り、補間と未補間は別の累積値で返す。補間区間に対応する媒体位置や、時間伸縮後のブロック内部の媒体位置は返さない。[音声セッション](../../src/playout/audioPlayoutSession.ts#L675-L710) は有効な出力時計があるときだけ、描画位置を `getOutputTimestamp()` の対応で換算して同期実績に入れる。

[`skewMs`](../../src/playout/timeline.ts#L936-L955) は、音声と映像それぞれの直近の `提示時刻 − 媒体時刻` を求め、映像側から音声側を引いた値である。同じ媒体時刻の組を照合する指標ではない。欠落中に新しい音声実績がなくても、映像は既存の時間軸で進められる。たとえば短いバースト欠落では、直前の実音の値が残るため、`skewMs` が小さくても補間区間で同期を観測したことにはならない。片方の実績が 1 秒を超えて古くなると `null` になる。

音声は AudioContext の出力時計への換算、映像は rAF と出力先の提示遅延の推定であり、物理出力の実測ではない。SDK の既定は MediaStream であり、要素へ渡した後の音声は元の AudioContext の時計では測れない。SDK の直接出力と DevTools の直接出力も、それぞれの出力経路を明示する。[出力経路と観測の制約](../PLAYOUT.md#L20-L34) を参照。

## ローカルの NetEq との違い

- **受信と取り出しの分離。** NetEq は復号前のパケットを保持し、`GetAudio()` の 10 ms 単位の取り出し時に必要な RTP 時刻、残量、前回のモードから次の操作を選ぶ。音が足りなければ対応するデコーダーの PLC を試し、使えなければ `Expand` を使う。`Expand` からの復帰に `Merge`、深さの調整に `Accelerate` / `PreemptiveExpand` を使う。moqt-js は出力での欠落判定と PCM の処理を部分的に採用しているが、WebCodecs の復号を含む一体の pull ではない。[NetEqImpl の出力処理](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/neteq_impl.cc#668)、[DecisionLogic](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/decision_logic.cc#264) を参照
- **目標遅延。** NetEq は RTP 時刻と pull の tick に基づく到着履歴を使い、通常到着で出力が空になるリスクと順序逆転の遅着を別に扱う。順序逆転の最適化を有効にした場合は両者の必要量の最大を採用し、遅延の下限と上限、容量の制約を掛ける。80 ms は開始時の値であって固定下限ではない。届かない Object を長く待っても取り戻せるとは限らない。[PacketArrivalHistory](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/packet_arrival_history.cc#25)、[DelayManager](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/delay_manager.cc#76)、[DelayConstraints](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/delay_constraints.cc#31) を参照
- **補間中にも進む媒体位置。** NetEq は `Expand` / codec PLC 中に出力したサンプル数だけ再生位置を進め、初回待ちやコンフォートノイズの一部では有効な時刻を返さない。WebRTC 上位は NetEq の位置と機器の出力遅延を分け、RTCP の RTP → NTP の対応で映像と照合する。moqt-js への参考点は **出力の進み、実音で確認した媒体位置、欠落中の推定、推定不能を区別する契約**であり、10 ms の周期や RTP の時刻変換を移植することではない。[NetEq の時刻更新](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/neteq_impl.cc#869)、[GetPlayoutTimestamp](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/modules/audio_coding/neteq/neteq_impl.cc#585)、[ChannelReceive](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/audio/channel_receive.cc#1087)、[WebRTC 上位の同期](https://webrtc.googlesource.com/src/+/a17aec85c45e25561c5760f37c95b88f076af49f/video/rtp_streams_synchronizer2.cc#180) を参照

## 既存の検証と次の計測

- [描画キューの単体テスト](../../src/playout/audioRenderQueue.test.ts#L5-L30) は予約だけでは提示通知を出さないことを検証し、[時間軸の単体テスト](../../src/playout/timeline.test.ts#L687-L750) は直近の実績と鮮度を検証する。今回は予約、描画キュー、欠落補間、統計、時間軸の既存単体テストを計 111 件実行し、すべて成功した
- [直接出力の精度試験](../../tests/e2e/media-playout-precision.spec.ts#L52-L110) は実 Worklet の通知と同じ媒体時刻の Canvas 描画を照合するが、80 ms の主スレッド停止条件は媒体の欠落注入ではない。[周期的な媒体欠落の試験](../../tests/e2e/media-playout-quality.spec.ts#L179-L256) は音声のみである。既存 E2E は今回は実行していない
- [A/V 計測の欠落条件](../../scripts/playout-arrival-events.mjs#L20-L52) は復号済み音声入力を間引く。現状の [A/V の照合](../../scripts/playout-av-latency.mjs#L176-L192) は音声予約の値を使い、[対応付け](../../scripts/devtools-latency-trace.mjs#L66-L87) は 40 ms 以内の先行する音声がない映像を除く。[実リレーの損失調査](../../tests/e2e/relay/investigation-audio-delay.spec.ts#L599-L688) も受信後の Datagram を間引く調査であり、回線自体の損失や物理出力を測るものではない

次は直接出力で、既存の A/V 計測を土台に **単発欠落、補間上限より短い / 長い連続欠落、欠落しない遅着**を分ける。まず音声だけを欠落させる。順序逆転と映像の参照欠落は別に復号前の経路で調べる。媒体時刻を維持した同じ入力に対し、AudioWorklet の出力サンプル位置、実音 / 補間 / 無音の区間、映像提示位置、最初の実音への復帰を照合する。欠落中と復帰後の同期の誤差に加え、観測できなかった区間、両媒体の遅延、未補間時間、描画しなかった映像の枚数を残す。

まず観測を追加し、待ち時間や映像を止める方針は変更しない。実音で確認した位置と、欠落中の短時間の推定を分け、長い欠落、時計の代用、時刻の世代変更では推定不能を残す。SDK の既定経路と物理出力は別条件で評価する。手順と結果の採否は [再生の計測](../PLAYOUT_MEASUREMENT.md) に従う。

## 実装後の課題

[直接出力の同期](../MEDIA_PLAYOUT.md#短い欠落時の同期) は描画済みの実音と補間を分け、
補正後の目標に最も近い映像を選ぶ。映像の破棄期限は補正前の提示時刻で判定する。
これは表示周期ごとの候補の中での選択であり、全区間の遅延や同期ずれの最小化ではない。

1. **最優先: 欠落中と復帰後の同期を測る。** [追加のブラウザーテスト](../../tests/e2e/media-playout-precision.spec.ts) は復号済みの音声を間引き、短い欠落、長い欠落、復帰時の報告を検証する。実ネットワークや物理出力は対象外で、未実行。次は同じ素材、到着列、画面周期を使って補正の有効 / 無効を比較する。欠落中と復帰後を分け、両媒体の遅延、絶対同期ずれの p95 / p99、観測できなかった比率、未補間時間、映像の破棄率を残す。スピーカーの音と画面を同じ測定器で採り、直接出力と MediaStream を別条件にする
2. **復号前の遅着と真の欠落を区別する。** 受信、復号、投入、描画の時刻と Object の位置を対応づけ、単発欠落、バースト欠落、順序逆転、主スレッド停止を別々に試す。未着をすべて待つと遅延を増やすため、遅着で回収できる割合に応じて待つ価値を評価し、復号器が対応する場合はコーデックの欠落補間も比較する
3. **映像を早く復帰させる。** 参照欠落でキーフレームを待つ区間は、音声との時刻合わせでは回復しない。映像の欠落を独立に注入し、最初の復号可能フレームまでの時間と復帰後の同期、追加のキーフレーム要求にかかる帯域を測る
4. **低遅延条件で観測が間に合う割合を増やす。** Worklet の通知は 48 kHz で約 21 ms ごとであり、出力の先行量が小さいか主スレッドが止まる場合には、選択時点で該当範囲が届かない。通知間隔と負荷の関係を測り、未知の割合が高い条件で短周期化を検討する。時間伸縮区間の観測を追加する場合は線形近似ではなく、加工で使った実際の媒体位置を対応づける
