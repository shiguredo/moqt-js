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
- Linux の Chrome for Testing Canary `160.0.8182.0` から、`WebTransportStats` の有効化フラグや輻輳制御方式を指定せず、ローカルの WebTransport over HTTP/3 サーバーへ単方向ストリームで送信した。UDP 中継の上り制限を 8 Mbps から 2 Mbps に変えると、連続送信した 3 試行で約 1 秒後の推定値は 1.98〜2.22 Mbps だった。一方、8 KiB の書き込みごとに 125 ms 待ち、送信を約 0.52 Mbps に抑えた試行では同時点の推定値は 8.25 Mbps だった。これは推定値の測定であり、MOQT の送信待ちや変更判定のしきい値は検証していない
- libwebrtc は、映像用の送信予算を符号化目標に換算し、通常のレート変更は稼働中のエンコーダーの `SetRates()` に渡す。エンコーダーの再初期化とは別経路である。WebCodecs に同等の `SetRates()` はないが、同じ `VideoEncoder` に設定を再投入できる。Chromium 160 は互換のある変更で内部実装の `ChangeOptions` を試し、拒否された場合は内部で再初期化する。JavaScript の `VideoEncoder` が同一でも、内部実装の再利用は保証されない
- 現行の `VideoEncoderWrapper.configure()` は直接実行で新しい `VideoEncoder` を作り、Worker モードでは Worker を差し替える。通常のレート更新ではこの初期化経路を使わない

## 設計方針

### 有効化する範囲と状態

- `src/codec/types.ts` の `VideoPublishOptions` に `adaptiveBitrate?: boolean` を追加する。省略または `false` の場合は既存の固定配信とし、`true` の場合だけ高レベルの `MediaPublisher` がレート適応を試みる。音声設定や QUIC 自体の輻輳制御は変えない。回線回復時の自動引き上げは対象外とする
- 最初の対応は `altGroup` と `keyframeSpacing` の両方が未指定の場合に限る。どちらかを指定した配信は固定とし、設定済みの切り替え境界や Group 内の Object 数に影響させない (draft-ietf-moq-msf-02 §4.3、§5.2.46)。音声、映像、Catalog のいずれかに配信元とは別の PUBLISH 購読が `PUBLISH_OK` で確立してから終了するまでは、複製分の送信予算を算出しないため適応を保留する。応答待ちの購読は含めない。保留中は既存の配送を続け、新しい更新は投入しない。すでに投入した更新の成否は後述のとおり扱う
- `src/session.ts` の `SessionImpl` に内部の観測経路を設け、配信中のセッションの `WebTransport.getStats()` と追加 PUBLISH 購読の有無を `MediaPublisherImpl` が参照できるようにする。ブラウザーの版で判定せず、実際の API と取得値を調べる。公開 `Session.getStatistics()` の契約は変えない
- `MediaPublisher` が配信中で、配信元の映像 PUBLISH が有効かつ休止していない間だけ観測する。配信者・配信元の映像 PUBLISH の休止、追加 PUBLISH の確立、または配信の終了では観測世代を進め、取得中の旧統計と未投入の候補を無効にする。追加 PUBLISH の確立は `src/session/publishedTracks.ts` の `publishedTracksOnSubscriptionEstablished` で記録し、観測の合間に確立・終了した場合も除外する。再開時は判定を新しく始める。`stop()` / `close()` の受付またはピア起点の切断では、保留中の更新・復旧の結果も失効させる。新しい `start()` は別の配信として初期値に戻す

### ビットレートを下げる条件

- `estimatedSendRate` は同じ接続のストリームとデータグラム全体の送信ペイロードの推定値 (bps) であり、映像の実測レートではない。500 ms ごとに取得を試み、同じ接続で取得は重ねない。観測時刻は `getStats()` を呼んだ時点の `performance.now()` とし、送信待ちの計測にも同じ時計を使う。取得に 500 ms を超えた回や、先行取得・タイマー遅延などで飛ばした回は欠損とする。同じ回を重ねて数えず、欠損、未対応、`null`、正の安全整数として扱えない値、取得失敗では連続判定をリセットする。これらを理由に配信や確定済みの目標値は変更しない
- `src/createMediaPublisher.ts` の `sendFrameFireAndForget` で、配信元の映像 `Publisher.sendObject()` 呼び出しから、その戻り値の Promise が解決または拒否されるまでを記録する。`WebTransport.getStats()` を呼ぶ時点で最古の未完了の経過時間を採り、同じ観測の送信待ちの指標とする。これは MOQT の送信キューから WebTransport への書き込みまでの待ちの近似であり、ネットワーク配送完了や ACK を表さない。即座に見送った送信やエンコード待ちを滞留と見なさない。計測のために映像の処理ループを送信完了待ちに変えない
- 映像予算は `max(0, floor(85 × estimatedSendRate / 100) - 音声予約)` (bps)。音声予約は音声なしなら 0、それ以外は設定音声ビットレートに元を含む送信回数 (Subgroup は 1、Datagram は設定した冗長送信回数) を掛け、端数を切り上げる。残した 15% は MOQT の制御・ヘッダーとメディアのレート変動に対する初期値であり、実測した比率ではない
- `floor(video.bitrate)` を適応判定の初期値、`min(floor(video.bitrate), 150_000)` bps を下限とする。映像予算をこの下限以上、最後に確定した目標以下に収めた整数を候補とする。適応に使う設定値と計算結果を安全な整数で扱えない場合は更新しない。予算が下限未満なら帯域内に収まる保証はない
- `10 × 候補 ≤ 9 × 確定済み目標` を満たす正の候補があり、最古の未完了の送信が 250 ms 以上の回が 3 回連続したときだけ下げる。不成立・欠損で連続数をリセットする。一つの更新の成否が決まるまでは次を投入しない。成功後はその後に採った観測だけを使い、成功から 2 秒間は次の更新を投入しない

### 既存エンコーダーでの更新

- `processVideoFrames` の映像入力境界で、同じ観測世代の直近 3 回が条件を満たし、最新の観測時刻から 500 ms 以内であることを確認して、その観測の候補を投入する。`VideoEncoderWrapper` と `videoEncoder.worker.ts` に専用の更新経路を設け、直接実行では同じ `VideoEncoder`、Worker モードでは同じ Worker 内の同じ `VideoEncoder` へ、`bitrate` だけを変えた構成を渡す
- 映像の新規入力を一時止めて `flush()` で投入済みの出力を出し切り、`configure()` → `flush()` の順で処理する。Worker でも旧 `encoded` 通知を更新完了より先に届ける。操作 ID を付けた更新完了は初期化の `configured` と区別する。旧出力は通常の配送判定に従い、レート変更だけを理由に捨てない。新しい入力を再開する前に、出力が出なかった旧入力の識別記録と Worker の未応答フレーム数もこの境界で解消する。設定処理が完了しても、更新後の入力から最初の非空の符号化出力を受け取るまでは目標値を確定しない
- 更新手順を投入した時点 (Worker では更新メッセージの送信) 以降、帯域条件の変化・休止・追加購読を理由に更新を取り消さない。休止や追加購読は新規の観測・投入だけを止め、投入済み更新は同じ配信と操作 ID の結果なら休止中でも受け取る。出力が配送対象かどうかと、設定の成否は別に判定する。観測世代で投入済みの結果を捨てない。終了済みの配信や別の操作の応答は無視する
- 通常の更新ではキーフレームを追加要求せず、復号設定が変わらない差分出力は既存 Group を継続する。キーフレームが出た場合は既存の採番で Group を開始し、付随する有効な新しい復号設定はその先頭 Object に載せる。有効な `decoderConfig.description` が変わった差分出力を受けたときは設定を保留し、キーフレームを要求する。そのキーまでは差分出力を送らず、新 Group の Object ID 0 で LOC `VIDEO_CONFIG` を送る。設定が再通知されない場合も、同じエンコーダーで保持している有効値を消さない
- 復号設定の変更や復旧で新 Group を始めるときは、配信元の購読の送信キューで、先頭キーの Object 本体を WebTransport へ書き込めた場合だけ、同じ Group の差分を順に書き込む。`sendObject()` の解決だけでは、途中の `PAUSED` などによる見送りを区別できないため成功としない (ACK は待たない)。先頭キーを見送った Group の差分は送らず、解除後など次に送信可能な時点で新しいキーを要求し、必要な復号設定を載せる。休止をまたいだ古いキーの結果では再開待ちを解除しない。他の購読の配送判定と Track 共通の採番は変えない

### 失敗時の復帰と統計

- 更新手順の投入から設定処理が 2 秒以内に完了しない、または更新後の最初の入力をエンコーダーに投入してから 2 秒以内に非空出力がない場合は失敗とする。設定完了後に入力がない間は後者の期限を開始しない。更新・復旧中に同じエンコーダーのエラーコールバックと操作の失敗応答が両方届いても、同じ操作の失敗として一度だけ処理する
- 設定投入前の拒否で旧エンコーダーが利用可能なら確定済み目標で続ける。閉鎖やタイムアウトなどで旧設定の継続を確認できない場合のみ、映像エンコーダーを破棄し、最後に確定した構成で一度だけ再生成する。古い出力は映像専用の世代で `pendingVideoConfig` などの更新より前に除外する。同じ映像 reader の入力先を復旧したエンコーダーへ切り替え、最初に送るキーフレームの Object ID 0 から新しい Group を開始し、必要な復号設定を載せる
- 再生成も設定完了と最初の投入からの出力にそれぞれ同じ期限を設け、最初の有効な出力はキーフレームであることを確認する。失敗後は同じ配信中に適応を再試行しない。復旧が失敗した場合は映像送信を止めて `onError` に一度通知する。復旧とその失敗で音声、セッション、トラックを作り直さない
- `video.bitrate` は WebCodecs の平均ビットレート目標の初期値と上限で、実出力の上限ではない。既存の Catalog の最大ビットレート宣言は変更に連動させない (draft-ietf-moq-msf-02 §5.2.23)。`MediaPublisher.getStats().video` で、最後に確定した `targetBitrate` (bps) と、実際の符号化出力の積算バイト数 `encodedBytes` (LOC・配送複製を含まない) を区別する。変更手続き中・復旧中は最後の確定値を返し、未設定・終了・復旧不能なら `targetBitrate` は `null` とする
- 設定と実出力の差やどこで詰まっているかを利用者が診断できるよう、固定配信・適応配信ともに `MediaPublisher.getStats().video.oldestPendingSendMs` で統計を読んだ時点の送信待ちを出す (未完了送信なしは 0 ms)。このローカル観測は `WebTransport.getStats()` を呼ばずに得られる。開始時には積算バイト数と送信待ちを初期化する

## 完了条件

- GitHub Actions の実リレー E2E で、`WebTransportStats` を有効にした Chromium か既定で対応する版を使う。配信側と購読側を別のブラウザープロセスにし、配信側の HTTP/3 接続を確認して Linux の `tc` で上り UDP フローだけを絞る。対象フローの制限と正の推定値、映像の送信待ちが生じたことを確認し、前提が成り立たない回を適応成功に数えない。制限は成功・失敗にかかわらず解除し、接続先の実値をログに出さない
- 再現可能な動きのある映像を使い、固定配信の符号化レートより狭く、映像の下限と音声をまかなえる上り容量にする。同じ入力・制限の固定配信に比べ、適応でのみ目標値が下がり、切り替えが落ち着いた等長の時間窓で `encodedBytes` から求めたレートと `oldestPendingSendMs` が小さくなることを確認する。制限前は設定値を維持し、制限解除後も目標値は上がらない
- Worker モードと直接実行モードで、更新前後が同じ MOQT セッション・映像トラックに属し、更新後の映像を実際に復号できることを確認する。例えば実リレーから低レベル API で映像を購読し、入力 Object の位置と対応する `VideoDecoder` の出力を検証する。通常更新の回は Chromium のソフトウェア VP8 と十分に長いキー間隔を使い、両モードで、更新後に符号化した差分 Object を更新前と同じ Group のまま少なくとも一つ実際に復号する。受信 Object 数で復号を代用しない
- 状態遷移の検証では、単発の低下、送信待ちなし、欠損、適用間隔内で新規更新しないこと、休止前の観測を復帰後に使わず投入済みの成否だけを記録すること、終了した配信の成否を次の配信へ持ち込まないことを確認する。更新失敗、タイムアウト、復旧失敗で未確定値を公開せず、同じ操作のエラー通知や復旧が重複しないことも確認する。復号設定を変えた場合と再生成後のキー境界、配信元の `PAUSED` でキュー済みのキーが見送られ、その後に休止が解除されても同じ Group の差分を書き込まないことは、送信キューの結果を入力にした純粋ロジックで別に検証する
- オプションの省略、`false`、API の未対応、`altGroup` または `keyframeSpacing` の指定時は固定で配信できる。追加 PUBLISH の確立後は新規更新しない。`docs/HIGH_LEVEL_API.md` に対象範囲、確定した目標値と実測の違い、休止・未対応・失敗時の動作、自動引き上げがないことを記載する

## 参照

- [W3C WebTransport: `estimatedSendRate`](https://w3c.github.io/webtransport/#dom-webtransportconnectionstats-estimatedsendrate)
- [Chrome Platform Status: WebTransport connection statistics](https://chromestatus.com/feature/5120203192139776)
- [W3C WebCodecs: VideoEncoder Methods](https://www.w3.org/TR/webcodecs/#videoencoder-methods)、[VideoEncoderConfig](https://www.w3.org/TR/webcodecs/#video-encoder-config)
- libwebrtc: [映像の予算計算と上限](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/video/video_send_stream_impl.cc#858)、[既存エンコーダーの `SetRates()`](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/video/video_stream_encoder.cc#1820)
- [Chromium 160: `VideoEncoder::ProcessReconfigure`](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8182.0/third_party/blink/renderer/modules/webcodecs/video_encoder.cc#1512)
- [draft-ietf-moq-msf-02](../refs/moq/draft-ietf-moq-msf-02.txt) §4.3 (Packaging for multi-variant track switching)、§5.2.23 (Maximum Bitrate)、§5.2.46 (Keyframe spacing)
- [draft-ietf-moq-loc-05](../refs/moq/draft-ietf-moq-loc-05.txt) §2.3.2.1 (Video Config)

## 解決方法

{未着手}
