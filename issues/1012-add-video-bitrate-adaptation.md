# 送信帯域の低下に応じて映像の目標ビットレートを下げる

- Created: 2026-11-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-video-bitrate-adaptation
- Polished: 2026-11-25

## 目的

配信中に上り回線が細くなったとき、映像のエンコード量を減らして送信待ちの蓄積を抑える。QUIC の輻輳制御で送信速度が下がっても、映像エンコーダーの目標値は下がらないため、配信側にレート適応を追加する。

## 現状

- `src/createMediaPublisher.ts` の `setupEncoders` は配信開始時に `VideoPublishOptions.bitrate` を使って映像エンコーダーを設定する。配信中の目標値を更新する経路はない
- `src/session.ts` の `SessionImpl` は `WebTransport` を保持しているが、`getStatistics` は MOQT の統計を返すだけで、WebTransport の送信レート推定値を取得していない
- Linux の Chrome for Testing Canary `160.0.8182.0` の既定設定で、ローカルの WebTransport over HTTP/3 サーバーへ単方向ストリームで送信した。UDP 中継の上り制限を 8 Mbps から 2 Mbps に変えると、連続送信した 3 試行で約 1 秒後の推定値は 1.98〜2.22 Mbps だった。一方、8 KiB の書き込みごとに 125 ms 待ち、送信を約 0.52 Mbps に抑えた試行では同時点の推定値は 8.25 Mbps だった。これは推定値の測定であり、MOQT の送信待ちや WebCodecs の切り替えは検証していない

## 設計方針

### 有効化する範囲と状態

- `src/codec/types.ts` の `VideoPublishOptions` に `adaptiveBitrate?: boolean` を追加する。省略または `false` の場合は既存の固定配信とし、`true` の場合だけ高レベルの `MediaPublisher` がレート適応を試みる。音声設定や QUIC 自体の輻輳制御は変えない。回線回復時の自動引き上げは対象外とする
- 最初の対応は `altGroup` と `keyframeSpacing` の両方が未指定の場合に限る。どちらかを指定した配信は固定とし、設定済みの切り替え境界や Group 内の Object 数に影響させない (draft-ietf-moq-msf-02 §4.3、§5.2.46)。音声、映像、Catalog のいずれかに配信元とは別の PUBLISH 購読が `PUBLISH_OK` で確立してから終了するまでは、複製分の送信予算を算出しないため適応を保留する。応答待ちの購読は含めない。保留中も、現在のビットレートと既存の配送は維持する
- `src/session.ts` の `SessionImpl` に内部の観測経路を設け、配信中のセッションの `WebTransport.getStats()` と追加 PUBLISH 購読の有無を `MediaPublisherImpl` が参照できるようにする。ブラウザーの版で判定せず、実際の API と取得値を調べる。公開 `Session.getStatistics()` の契約は変えない
- `MediaPublisher` が配信中で、配信元の映像 PUBLISH が有効かつ休止していない間だけ観測する。配信者または配信元の映像 PUBLISH の一時停止、追加 PUBLISH の確立、`stop()` / `close()` の受付またはピア起点の切断で観測と準備中の切り替えを無効化する。追加 PUBLISH の確立は `src/session/publishedTracks.ts` の `publishedTracksOnSubscriptionEstablished` で記録し、観測の合間に確立して終了した場合も見落とさない。統計の取得や候補の準備を待った後も同じ配信と同じ観測世代かを確認し、古い結果は使わない。再開時は連続判定をやり直し、現在の目標値を維持する。新しい `start()` では `video.bitrate` に戻す

### ビットレートを下げる条件

- `estimatedSendRate` は同じ接続のストリームとデータグラム全体の送信ペイロードの推定値 (bps) であり、映像の実測レートではない。500 ms ごとに取得を試み、同じ接続で取得は重ねない。観測時刻は `getStats()` を呼んだ時点の `performance.now()` とし、送信待ちの計測にも同じ時計を使う。呼び出しから 500 ms を超えた結果と、先行の取得が未完了で呼べない回は欠損とする。欠損、未対応、`null`、有限かつ正の数値でない結果、取得失敗では連続判定をリセットし、配信と現在の目標値は維持する
- `src/createMediaPublisher.ts` の `sendFrameFireAndForget` で、配信元の映像 `Publisher.sendObject()` 呼び出しから、その戻り値の Promise が解決または拒否されるまでを記録する。`getStats()` を呼ぶ時点で最古の未完了の経過時間を採り、同じ観測の送信待ちの指標とする。これは MOQT の送信キューから WebTransport への書き込みまでの待ちの近似であり、ネットワーク配送完了や ACK を表さない。即座に見送った送信やエンコード待ちを滞留と見なさない。計測のために映像の処理ループを送信完了待ちに変えない
- 映像の予算は `floor(estimatedSendRate × 0.85 - 音声予約)` (bps) とする。音声予約は音声なしなら 0、Subgroup なら設定音声ビットレート、Datagram なら設定音声ビットレートに実際の冗長送信回数を掛けた値。残した 15% は MOQT の制御、ヘッダー、メディアのレート変動に対する初期実装の余裕であり、実測した比率ではない
- 候補は映像予算を `min(floor(video.bitrate), 150_000)` bps 以上、現在の目標値以下に収めた整数とする。正の整数の候補が作れない場合は適用しない。予算が下限を下回っても下限までしか下げないため、帯域内に収まる保証はない。候補が現在の目標値より 10% 以上低く、最古の未完了の送信が 250 ms 以上の状態を 3 回連続の観測で確認したときだけ下げる。不成立または欠損で連続数をリセットし、変更の成功から 2 秒間は次の変更を行わない。次の判定には変更後に採った観測だけを使う

### エンコーダーへの適用

- `src/codec/VideoEncoder.ts` と Worker 側で、現在の映像エンコーダーを残したままビットレートだけを変えた候補を準備する。`configure()` の返りや Worker の `configured` 応答だけで成功とせず、入力ループで実フレームを 1 枚複製し、必要な `flush()` も含めて候補からキーフレームが出ることを確認する。確認用の出力は送らない。準備に失敗、または開始から 2 秒以内に確認できない場合は候補だけを破棄し、現在の配信を維持して同じ `start()` で始めた配信中は再試行しない
- 候補は同時に 1 つだけ準備し、準備中も観測を続ける。適用直前に、同じ観測世代の直近 3 回で減少条件が成立し、最新の観測が 500 ms 以内で、準備済みの目標値がその観測から同じ下限処理で求めた候補値以下の場合だけ、`processVideoFrames` の同じ入力ループで次のフレームから切り替える。条件を外れた候補は破棄し、通常の判定に戻る
- 切り替え後に最初に送る出力はキーフレームにし、新しい Group の Object ID 0 にする。確認用出力に `decoderConfig.description` が付いていた場合は候補に保持し、実送信する先頭キー自身に有効な `description` がなければ、その保持値を既存の LOC `VIDEO_CONFIG` の判定へ渡す。切り替え時に旧エンコーダーの `pendingVideoConfig` と `lastSentVideoConfig` を破棄し、旧エンコーダーの遅延出力は映像専用の世代で除外してどちらも更新させない。音声の処理世代、セッション、トラックは切り替えない
- `video.bitrate` は WebCodecs に渡す平均ビットレートの目標の初期値と上限とし、瞬間的な出力レートの上限とは見なさない。Catalog の `bitrate` は最大ビットレートの宣言なので、目標値の切り替えでは更新しない (draft-ietf-moq-msf-02 §5.2.23)。`MediaPublisher.getStats().video.targetBitrate` (bps) に候補ではなく適用済みの値を出す。一時停止中は値を維持し、エンコーダーが未設定または解放済みなら `null` とする

## 完了条件

- GitHub Actions の実リレー E2E で、専用の Chromium 起動に `--enable-blink-features=WebTransportStats` を渡すか、既定で対応する版を使う。配信側と購読側を別のブラウザープロセスに分け、配信側の QUIC/UDP フローだけを Linux の `tc` で送信元・宛先のアドレスと UDP ポートを指定して制限し、試行後に解除する
- 制限前の符号化レートが制限後の上り容量を超える映像入力を使い、適応側で正の推定値と送信待ちを観測する。同じ入力と制限の固定配信と比較し、有効時だけ適用目標値と切り替え後の符号化レートが下がることを確認する。符号化レートは送信前の `EncodedVideoChunk` のバイト数を同じ長さの時間窓で比べ、受信バイト数や既存の LOC 込み `bytesSent` で代用しない。制限前は設定値を維持し、制限を解除しても適用目標値は上がらない
- Worker モードと直接実行モードで、切り替え前後が同じ MOQT セッションと映像トラックであること、新しい Group がキーフレームから始まること、購読側の切り替え後の Group に対応する実際の復号出力が得られることを確認する。受信 Object 数だけで判定しない
- 単発の低下、送信待ちなし、推定値の欠損や取得失敗、適用間隔内では目標値を変えない。停止・一時停止に先立つ観測や準備の結果は復帰後に適用しない。候補の準備失敗で現在のエンコーダーを失わないことを確認する
- オプションの省略、`false`、API の未対応、`altGroup` または `keyframeSpacing` の指定時は固定で配信できる。追加 PUBLISH 購読がある間は最後の適用値を維持する。`docs/HIGH_LEVEL_API.md` に設定と対象範囲、未対応時と一時停止後の動作、自動引き上げがないことを記載する

## 参照

- [W3C WebTransport: `estimatedSendRate`](https://w3c.github.io/webtransport/#dom-webtransportconnectionstats-estimatedsendrate)
- [Chrome Platform Status: WebTransport connection statistics](https://chromestatus.com/feature/5120203192139776)
- [W3C WebCodecs: VideoEncoder Methods](https://www.w3.org/TR/webcodecs/#videoencoder-methods)、[VideoEncoderConfig](https://www.w3.org/TR/webcodecs/#video-encoder-config)
- [draft-ietf-moq-msf-02](../refs/moq/draft-ietf-moq-msf-02.txt) §4.3 (Packaging for multi-variant track switching)、§5.2.23 (Maximum Bitrate)、§5.2.46 (Keyframe spacing)
- [draft-ietf-moq-loc-05](../refs/moq/draft-ietf-moq-loc-05.txt) §2.3.2.1 (Video Config)

## 解決方法

{未着手}
