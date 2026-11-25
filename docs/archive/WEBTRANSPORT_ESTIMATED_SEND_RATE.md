# WebTransport の送信帯域推定と映像のレート適応

2026-11-25 (JST) に Linux の Chrome for Testing (headless shell) から実際の WebTransport over HTTP/3 サーバーに接続した。
`WebTransport.getStats()` は Stable 158 と Beta 159 では既定で公開されず、Canary 160 では機能フラグなしで `estimatedSendRate` を取得できた。
この記録では、Chromium の実測、Safari の公開試験と実装、WebCodecs のレート適応に SCReAMv2 の考え方を使える範囲を区別する。

## 公開状況

| チャネル | 版 | `WebTransportStats` を明示しない場合 | `--enable-blink-features=WebTransportStats` を指定した場合 |
| --- | --- | --- | --- |
| Stable | `158.0.8127.88` | `getStats` は `undefined` | `estimatedSendRate` は数値 |
| Beta | `159.0.8154.33` | `getStats` は `undefined` | `estimatedSendRate` は数値 |
| Canary | `160.0.8182.0` | `estimatedSendRate` は数値 | 未試行 |

検証した版は当日の [Chrome for Testing チャネル一覧](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json) と一致する。
[初期の公開告知](https://groups.google.com/a/chromium.org/g/blink-dev/c/5l8SOjnVXXY) では M159 の予定だったが、[Chrome Platform Status の最新情報](https://chromestatus.com/api/v0/features/5120203192139776) では M160 に変わっている。
[Chrome 160 のリリースノート](https://chromestatus.com/release-notes/160) は接続統計を掲載しており、Stable の予定日は 2027-01-05。

## Chromium が返す値

`estimatedSendRate` はブラウザーから接続先への**送信**について、同じ WebTransport セッションの全ストリームとデータグラムが共有するアプリケーションペイロードの推定レート (bps)。
受信スループット、実際に送達したレート、映像に割り当てられる帯域、追加で使える残りの帯域のいずれでもない。
[W3C WebTransport §6.13](https://w3c.github.io/webtransport/#web-transport-connection-stats) のエディターズドラフトでは、推定できないときは `null` と定義している。

Chromium 160 の HTTP/3 専用接続では、[既定の輻輳制御は CUBIC](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8182.0/net/quic/dedicated_web_transport_http3_client.cc#454)。
CUBIC の `BandwidthEstimate()` は輻輳ウィンドウを平滑化 RTT で割って帯域を見積もる。RTT 未計測なら内部値は 0。
同じ版では、アプリケーションが `congestionControl: "throughput"` または `"low-latency"` を指定すると、どちらも BBRv2 を選ぶ。Chromium 内部の上書き設定が優先する。
BBRv2 は受信した ACK に基づく帯域サンプルを使うため、CUBIC と同じ数式ではない。

- [QUICHE の CUBIC 推定](https://quiche.googlesource.com/quiche/+/389b3116b7b9ed16a09d0772a8f336f38b25b201/quiche/quic/core/congestion_control/tcp_cubic_sender_bytes.cc)
- [QUICHE の BBRv2 推定](https://quiche.googlesource.com/quiche/+/389b3116b7b9ed16a09d0772a8f336f38b25b201/quiche/quic/core/congestion_control/bbr2_misc.h#477)
- [QUICHE のオーバーヘッド補正](https://quiche.googlesource.com/quiche/+/389b3116b7b9ed16a09d0772a8f336f38b25b201/quiche/quic/core/web_transport_stats.cc#41)

QUICHE は `(1 - オーバーヘッドの推定比率) × 輻輳制御の帯域推定 (bps)` を接続統計に載せる。
ネットワークサービスはその値を Mojo で渡し、[Blink](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8182.0/third_party/blink/renderer/modules/webtransport/web_transport.cc#2961) は正の値を `estimatedSendRate` として公開する。0 以下なら `null`。
エディターズドラフトの `atSendCapacity` は、アプリケーションが回線容量に達するまで送っているかどうかを示す。`false` なら、送信量の少なさで推定の精度が落ちている可能性がある。検証した [Chromium の接続統計の IDL](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8182.0/third_party/blink/renderer/modules/webtransport/web_transport_connection_stats.idl) には `atSendCapacity` と接続全体の `bytesSent` がなく、実測結果でも両方が存在しなかった。
ローカルの `close()` 後に取得した統計は直前のスナップショットと同じだった。閉じた接続の数値を新しい推定として扱わない。

## 実測条件と結果

- ローカルの [webtransport-go v0.13.0](https://github.com/quic-go/webtransport-go/tree/v0.13.0) を使ったサーバーに Chrome から接続。サーバー証明書は `serverCertificateHashes` で検証
- 各試行で新しいブラウザープロファイルを使用。検証ホストではブラウザーのサンドボックスを起動できなかったため、ローカルの検証ページに限りサンドボックスなしで起動
- UDP 中継を使う試行では片道 10 ms の遅延を置き、上りの UDP ペイロードの設定レートを接続開始から約 3 秒後に 8 Mbps から 2 Mbps へ変更。送信待ち時間の上限は約 45 ms
- 送信負荷をかける試行では、1 本の送信単方向ストリームに 32 KiB ずつ書き込み、約 450 ms ごとに接続統計とサーバーが読んだペイロードの累積バイト数を取得
- アプリケーションが送信量を制限する試行では、1 回 8 KiB を書き込み、書き込みのたびに 125 ms 待機。UDP 中継での破棄は 0 件

次表は `estimatedSendRate` の観測値 (Mbps)。変更前は制限切替の約 0.35 秒前。変更直後は切替の約 0.10 秒後。
単発の値は 1 試行のサンプル、幅は 3 試行の最小値〜最大値。

| 条件 | 試行数 | ペイロード送信前 | 制限変更前 | 変更直後 | 約 0.56 秒後 | 約 1.01 秒後 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Stable、フラグ有効、送信負荷あり | 1 | 15.73 | 7.98 | 6.29 | 2.86 | 2.30 |
| Canary、既定、送信負荷あり | 3 | 15.72〜16.95 | 7.99〜8.13 | 6.21〜6.28 | 2.73〜2.85 | 1.98〜2.22 |
| Canary、`low-latency`、送信負荷あり | 1 | 0.52 | 8.09 | 8.01 | 2.80 | 2.01 |
| Canary、既定、アプリケーションが送信量を制限 | 1 | 15.99 | 14.06 | 11.74 | 9.13 | 8.25 |
| Canary、`low-latency`、アプリケーションが送信量を制限 | 1 | 0.51 | 2.31 | 2.31 | 2.31 | 2.31 |

Canary の既定設定で送信負荷をかけると、サーバーが読んだペイロードの実測レートは制限変更前の 7.82〜7.90 Mbps から変更後の 1.93〜2.02 Mbps に下がった (変更前は開始約 1.30〜2.66 秒、変更後は約 4.46〜5.82 秒の各区間)。
一方、アプリケーション側で約 0.52 Mbps に制限した上で上りの制限を 2 Mbps にした場合、既定設定で約 1 秒後の推定は 8.25 Mbps、同じ試行の変更後区間にサーバーが読んだレートは 0.52 Mbps だった。
この環境では接続直後から数値が出ており、`null` は観測していない。

### Chrome 160 Canary での再測定

同日の別の試行で、`160.0.8182.0` を `WebTransportStats` フラグなし、輻輳制御の明示指定なしで起動した。ローカルの HTTP/3 上の WebTransport で単方向ストリームを使い、UDP 中継で片道 10 ms の遅延を入れ、上りの設定上限だけを 8 Mbps から 2 Mbps に変更した。推定値を 250 ms ごとに採った。

| 送信条件 | 試行数 | 制限変更の約 0.25 秒前の推定 (Mbps) | 約 0.5 秒後の推定 (Mbps) | 約 1 秒後の推定 (Mbps) | サーバー受信レート (Mbps、変更前 → 変更後) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 連続送信 | 3 | 7.98〜8.16 | 2.78〜3.28 | 1.98〜2.34 | 7.82〜8.00 → 1.95〜1.99 |
| 8 KiB ごとに 125 ms 待機 | 1 | 13.34 | 8.37 | 8.12 | 0.52 → 0.52 |

受信レートは、制限変更の約 2 秒前から 0.25 秒前、約 1 秒後から 2.5 秒後までにサーバーが読んだペイロード量から求めた。連続送信では制限変更に追従したが、アプリケーションが送信量を抑えた試行では約 1 秒後も現在の上り上限を上回る推定値が残った。

### 上り制限の変更から 1、5、10 秒後の推定

同じ Chrome 160 Canary (`160.0.8182.0`) と UDP 中継で、送信開始から約 3 秒後に上りの設定上限を 8 Mbps から 2 Mbps に変更し、変更後 10 秒まで観測した。連続送信と 8 KiB ごとに 125 ms 待つ送信を各 3 回試し、`WebTransportStats` の有効化フラグと輻輳制御のオプションは指定しなかった。各値は試行間の最小値から最大値までの範囲 (Mbps)。

| 送信条件 | 変更約 0.25 秒前の推定 | 1 秒後の推定 | 5 秒後の推定 | 10 秒後の推定 | 9〜10 秒のサーバー受信レート |
| --- | ---: | ---: | ---: | ---: | ---: |
| 連続送信 | 8.09〜8.19 | 1.89〜2.29 | 1.98〜2.34 | 1.98〜2.35 | 1.88〜1.95 |
| 送信量を約 0.52 Mbps に制限 | 13.27〜13.52 | 8.10〜8.14 | 7.94〜7.98 | 7.93〜7.96 | 0.52 |

連続送信では約 1 秒で 2 Mbps 前後まで下がり、5 秒後と 10 秒後も同程度だった。低負荷では、10 秒後も約 8 Mbps と、上りの設定上限の約 4 倍を示した。これは上りを使い切らない場合、観測時間を延ばすだけでは正確な上限が得られない例である。

### 上り制限の変更から 30 秒後までの再測定

同じ条件で各 3 回を新たに測定した。上りの設定上限を 8 Mbps から 2 Mbps に変え、同じ接続のまま 1、5、10、30 秒後の `estimatedSendRate` を記録した。単位は Mbps。

| 送信条件 | 変更約 0.25 秒前の推定 | 1 秒後の推定 | 5 秒後の推定 | 10 秒後の推定 | 30 秒後の推定 | 29〜30 秒のサーバー受信レート |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 連続送信 | 8.14〜8.18 | 1.98〜2.28 | 2.25〜2.31 | 1.99〜2.33 | 1.91〜1.97 | 1.88〜1.99 |
| 送信量を約 0.52 Mbps に制限 | 13.33〜13.58 | 8.15〜8.17 | 7.97〜8.00 | 7.91〜7.98 | 7.95〜8.35 | 0.52 |

連続送信では 30 秒後も設定上限に近く、低負荷では 30 秒経っても上りの設定上限の約 4 倍を示した。低負荷の 3 回では UDP 中継での破棄はなかった。

### 上り 2 Mbps のままアプリの送信目標を 0.5 Mbps から 4 Mbps に変更

Chrome 160 Canary (`160.0.8182.0`) を同じ設定で起動し、1 回測定した。上りの設定上限を 8 Mbps から 2 Mbps に変更した時点を 0 秒とした。アプリはそれ以前から平均 0.5 Mbps でデータを生成し、30 秒に同じ WebTransport ストリーム向けの生成目標だけを 4 Mbps に上げた。回線の設定上限は 60 秒まで 2 Mbps のまま。生成は 8 KiB 単位で、最大 256 KiB のアプリ側の待ち行列を超える分は破棄した。

| 時刻 (秒) | `estimatedSendRate` (Mbps) |
| ---: | ---: |
| 30.00 | 7.97 |
| 30.25 | 4.57 |
| 30.50 | 3.34 |
| 30.75 | 2.20 |
| 31.00 | 2.27 |
| 35.00 | 2.24 |
| 40.00 | 2.27 |
| 60.00 | 1.99 |

0〜30 秒の平均生成量と実受信レートはともに約 0.50 Mbps だった。30〜60 秒の平均生成量は 4.00 Mbps、書き込みが完了したレートは 1.98 Mbps、サーバーの実受信は 1.95 Mbps だった。この試行では低負荷の間に約 8 Mbps を示した推定値が、同じ接続で回線を使い切る負荷をかけてから約 0.75 秒で 2.20 Mbps まで低下した。

## Safari / WebKit の接続統計と送信帯域推定

2026-11-25 (JST) に、接続統計 API を呼べることと、送信帯域推定が数値を返すことを分けて確認した。

- [Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/) から WebTransport が公開されている。[互換性データ](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/getStats#browser_compatibility) 上は `getStats()` も Safari 26.4 から利用できる
- Safari 27.2 (`22625.2.8.11.9`) の [公開 Web Platform Tests 実行結果](https://wpt.fyi/api/search?run_id=4792976489054208&q=webtransport%2Fstats.https.any.html) では、接続後の `getStats()` は統計オブジェクトを返したが、`minRtt` が 0 で試験に失敗した。[対応する Cocoa 実装](https://github.com/WebKit/WebKit/blob/WebKit-7625.2.8.11.9/Source/WebKit/NetworkProcess/webtransport/cocoa/NetworkTransportSessionCocoa.mm#L410-L414) は接続統計の初期値を返すだけで、`estimatedSendRate` を計算しない
- Safari Technology Preview 257 は [公開の同試験](https://wpt.fyi/api/search?run_id=5299878864093184&q=webtransport%2Fstats.https.any.html) を 8 件とも通過したが、[試験コード](https://github.com/web-platform-tests/wpt/blob/de3c5d09c7b01a10b5d60cfdeac7fd37d929d579/webtransport/stats.https.any.js#L4-L24) は `estimatedSendRate` が `null` でも合格する。[同版のリリースノート](https://webkit.org/blog/18652/release-notes-for-safari-technology-preview-257/) が示す WebKit の版では、[送受信バイト数を集計する](https://github.com/WebKit/WebKit/blob/b7e4f1ae76f66dd30c14c27d46770d7e3f2795f5/Source/WebKit/NetworkProcess/webtransport/NetworkTransportSession.cpp#L178-L204) 一方、`estimatedSendRate` は [既定の `null`](https://github.com/WebKit/WebKit/blob/b7e4f1ae76f66dd30c14c27d46770d7e3f2795f5/Source/WebCore/Modules/webtransport/WebTransportConnectionStats.idl#L32-L49) のまま
- Linux の Playwright 付属 WPE WebKit ではローカルのセキュアコンテキストに `WebTransport` 自体が現れず、機能を有効化する起動オプションを指定しても接続を試行できなかった。同じ HTTP/3 サーバーに Chrome 160 Canary は接続し、64 KiB の送信後に正の推定値を取得した。Safari 実機での独自測定はしていない

Safari の `getStats()` の存在を帯域推定の対応判定に使わない。送信バイト数の時間差分も、現在の上り容量や送達確認を表す値ではない。

## moqt-js での利用上の判断

送信しているときの帯域低下を捉える補助信号としては使えるが、起動時または送信量が少ないときの値をそのまま WebCodecs の目標ビットレートにはできない。
`getStats()` の存在と有限かつ正の値を確認し、未対応、`null`、取得エラー時は固定設定で配信を続ける。制御する場合は送信の詰まりなども観測し、音声と配信制御に使う帯域を差し引いてから映像の上限を決める。
実リレーでの配信、WebCodecs の再設定、実回線での追従時間は実測していない。

### SCReAMv2 から参照する範囲

[SCReAMv2 ドラフト -03 §3](https://datatracker.ietf.org/doc/html/draft-ietf-ccwg-rfc8298bis-screamv2-03#section-3) は、ネットワークの輻輳制御、パケットの送信制御、映像のレート制御を連動させる。[§1.2](https://datatracker.ietf.org/doc/html/draft-ietf-ccwg-rfc8298bis-screamv2-03#section-1.2) の前提は RTP に限らないが、受信時刻とパケット単位の配送結果を WebTransport の接続統計で代用することはできない。ブラウザーの公開 API から QUIC の輻輳制御を SCReAMv2 に差し替えることもできない。

[§4.4](https://datatracker.ietf.org/doc/html/draft-ietf-ccwg-rfc8298bis-screamv2-03#section-4.4) からは、転送側の見積もりと映像の目標を分け、送信待ちとフレームサイズの変動に余裕を持たせる考え方を参照できる。`estimatedSendRate` は SCReAMv2 の参照ウィンドウから求めた値ではないため、式と定数は流用しない。アプリケーションの送信待ち時間もネットワークの片道キュー遅延とは別である。初版の設計では、送信待ちが続き、有効な推定値から求めた映像予算が現在の目標を十分に下回った場合だけ、映像の目標を下げる。回復時の引き上げと帯域の探索は別に検証する。

### libwebrtc の RTP 送信側

libwebrtc の [輻輳制御の選択](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/api/transport/goog_cc_factory.cc#33) では、`WebRTC-Bwe-ScreamV2` が `Enabled` で、RFC 8888 の RTCP フィードバックをネゴシエートした場合に SCReAMv2 を選ぶ。`mode:always` は RFC 8888 を必須にしない実験設定で、指定がない場合は Google Congestion Control (GCC) を選ぶ。

[`ScreamNetworkController`](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/modules/congestion_controller/scream/scream_network_controller.cc#208) は RTCP から得たパケットの受信情報を使い、RTP の送信ペース、送信中のデータ量の上限、目標レートを更新する。目標レートは [メディアの送信予算に配分](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/call/call.cc#1170) され、映像のレート変更は稼働中のエンコーダーの [`SetRates()`](https://webrtc.googlesource.com/src/+/d8d1b0b76d3a9fa7f4cd8295efb2ccadc07bed87/video/video_stream_encoder.cc#1851) に届く。WebCodecs に同等のメソッドはなく、[Chromium の `VideoEncoder` の再設定](https://chromium.googlesource.com/chromium/src/+/refs/tags/160.0.8182.0/third_party/blink/renderer/modules/webcodecs/video_encoder.cc#1512) は互換のある変更で内部エンコーダーの再利用を試みるが、同じ JavaScript オブジェクトを使っても内部エンコーダーの再利用は保証されない。

### QUIC の送信側での選択

[RFC 9002 §7](https://www.rfc-editor.org/rfc/rfc9002.html#section-7) は、送信側が輻輳制御を選べると定めている。送信側で QUIC の実装を選べるなら、BBRv3 の代わりに SCReAMv2 を組み込める。相手も同じ輻輳制御を使う必要はないが、片道キュー遅延を使う方式には、相手が [QUIC Receive Timestamps 拡張](https://datatracker.ietf.org/doc/html/draft-ietf-quic-receive-ts-04#section-4) などでパケットの受信時刻を返す必要がある。通常の QUIC ACK からはその時刻を得られない。

[`moq-congestion`](https://github.com/moq-dev/moq/blob/1fd8509de7db83b29257936afbc4eee6fce2dfbf/rs/moq-congestion/README.md) は、SCReAMv2 の [遅延ベースの制御](https://github.com/moq-dev/moq/pull/7547) を QUIC で BBRv3 と比較している。確認した版では L4S の経路を含まず、実験用の `lab` 機能でのみ利用できる。ネイティブ配信者やリレー自身の送信ではこの方法を検討できるが、リレーが採用してもブラウザーからリレーへ送る方向の輻輳制御は変わらない。
