# webtransport-devtools の WebTransport API 判定監査

- 調査日: 2026-11-01
- 対象: `devtools/src/webtransport-devtools/` の判定処理
  - 静的 API 対応チェック: `signals.ts` の `detectStaticApiSupport()`
  - ブラウザ対応バッジ: `bcd.ts` と `BcdBadges.tsx`
  - 接続後の実行時チェック: `signals.ts` の `connect()` / `wtApiSupport` ツリー
  - 設定の入力検証: `params.ts`
- 判定の基準:
  - W3C WebTransport Candidate Recommendation Snapshot, 30 July 2026 (`https://www.w3.org/TR/webtransport/`) の IDL
  - MDN WebTransport API と MDN Browser Compat Data (2026-10-31 時点の `main`)
  - Playwright 同梱ブラウザでの実測 (Chromium 156.0.8078.4 / Firefox 157.0 / WebKit 605.1.15)
- 本レポートは「devtools が判定していること」と「W3C / MDN が定義していること」の差分を示す。実装の修正は行っていない。

## 0. 結論

現状の判定は「接続前にプロトタイプ上のプロパティ名を `in` で数える」「接続後に一部のプロパティ値を読む」「設定値を入力時に検証する」の 3 系統で構成されている。

静的 API 対応チェックの役割は「接続前にネットワークを使わずに、このブラウザで API が存在するかを判定する」ことである。したがって存在確認を落とし所にするのは妥当であり、動作確認まで求めるべきではない。その前提で足りていないのは次の 4 点である。

1. 存在確認の網羅性: CR の IDL にありながら静的チェックの一覧に無い API が 9 項目ある。存在確認のままで追加できる (うち `WebTransportError` のコンストラクタと既定値はネットワークを使わずに確認できる)。
2. 存在確認の正確性: `WebTransportSendStream.getWriter` は `WritableStream` の継承のため `in` 演算子では常に真になり、存在確認そのものが誤る。`WebTransportWriter` の存在かプロトタイプの同一性で判定する必要がある。
3. 接続を使わずに直せる誤判定が 3 件ある。`supportsReliableOnly` をインスタンスから読んでいる (常に N/A)、接続失敗時に `Disconnected` と表示する、HTTP バージョン判別の `--` が「未確立」と「未実装」を区別しない。加えて「All Supported」という表示は存在確認にすぎないことを示していない。
4. BCD テーブルと入力検証は接続不要で直せる。BCD テーブルは 11 項目中 9 項目が BCD 現行データと一致し、2 項目 (Safari の `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`) が食い違う。`protocols` が BCD に追加済み (2026-08-28) であるのに未収録で、`experimental` / `preview` / `partial_implementation` / `notes` を表現できない。確認日 `2026-08-05` は約 3 か月前である。`protocols` の文字種などの入力検証も不足している。

接続後にしか確認できない動作 (`getStats()` の呼び出し、`incomingBidirectionalStreams` の消費、`createSendGroup()` / `sendGroup`、`WebTransportWriter`、BYOB リーダー、`maxDatagramSize` 超過の警告) は、サーバーを用意できない環境では検証できない。そのため静的パネルの判定や「All Supported」の母集団には含めず、接続成功時だけ表示する任意の実行時チェックとして切り離すのが落とし所である。

## 0.1 対応状況 (2026-11-01 実装)

P0 と P1 の接続不要の項目を実装し、接続せずに検証できる範囲を確認した。実装内容と検証結果は付録 D にまとめる。§2 以降の記述は監査時点 (実装前) の構成である。

## 1. 調査方法

### 1.1 一次資料

| 資料                  | URL                                                                | 備考                                                                                            |
| --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| W3C CR (2026-07-30)   | https://www.w3.org/TR/webtransport/                                | 本文と IDL の一次資料。IDL は HTML の `<pre class="def highlight idl">` 18 ブロックから抽出した |
| W3C CR の固定 URL     | https://www.w3.org/TR/2026/CR-webtransport-20260730/               | 上記と同一内容であることを確認                                                                  |
| W3C Editor's Draft    | https://raw.githubusercontent.com/w3c/webtransport/main/index.bs   | CR との差分確認用。IDL の差は `responseHeaders` の `[SameObject]` の有無のみ                    |
| MDN WebTransport API  | https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API  | 2026-10-31 時点の mdn/content `main` (commit `a0ba038`)                                         |
| MDN BCD               | https://github.com/mdn/browser-compat-data                         | 2026-10-31 時点の `main` (commit `0efedff8`)                                                    |
| WebTransport overview | https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview | `protocols` の交渉の前提確認用 (rev 13)                                                         |

### 1.2 実測

Playwright に同梱されたブラウザで、localhost (secure context) のページから API の有無とプロパティを観測した。接続先の WebTransport サーバーは用意していないため、セッション確立後の値 (ネゴシエート結果、統計、datagram の実送信) は未検証である。

- Chromium: `HeadlessChrome/156.0.8078.4` (2026-11-01 の安定版 Chrome 156 と一致)
- Firefox: `Firefox/157.0` (Playwright 同梱。BCD 上の安定版は 159)
- WebKit: `Version/27.2 Safari/605.1.15` (Playwright 同梱の trunk 相当。Safari 安定版とは一致しない場合がある)

### 1.3 「足りていない」の定義

本レポートでは次を「判定が足りていない」とする。

1. CR の IDL に存在する API を、静的チェック・実行時チェックのどちらでも判定していない。
2. CR または MDN / BCD が定義する挙動 (例外、無視、切り詰め、上限) を、入力検証・表示で判定していない。
3. 実際の挙動と異なる判定、または利用者に誤解を与える表示になっている。

### 1.4 判定の役割分担 (落とし所)

本レポートでは、静的 API 対応チェックの責務を「接続前にネットワーク I/O を発生させずに、API の存在を判定する」ことに限定する。存在確認は接続不要で CI でも回せるため、ここを落とし所とするのは妥当である。動作の保証は静的チェックの責務に含めない。

- 静的パネル: 存在確認のみ。動作・値・例外は保証しない。サマリと項目の文言も「存在する」ことを示す表現にする。
- 接続後の表示: 接続したセッションについて、値・状態・エラーを表示する。
- 接続後にしか確認できない動作 (統計の呼び出し、サーバー起点ストリーム、送信順序、writer、BYOB など) は、接続成功時だけ表示する任意の実行時チェックとし、静的パネルの判定には含めない。サーバーを用意できない環境では未実行のままにする。
- `new WebTransportError()` の既定値 (`source` / `streamErrorCode`) はネットワークを使わないため、静的チェックに含めてよい。

## 2. 現在の判定の棚卸し

本章以降 (§2〜§4) は監査時点 (実装前) の記述である。実装後の構成は付録 D を参照する。

### 2.1 静的 API 対応チェック (42 項目)

`signals.ts:135` の `detectStaticApiSupport()` がページロード時に 1 回だけ評価する。結果は `signals.ts:454` の `wtStaticApiSupport` に入り、`StaticApiSupportPanel.tsx` がサマリとグループ別の一覧を表示する。

| グループ             | 項目数 | 内容                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global               | 7      | `WebTransport` / `WebTransportError` / `WebTransportBidirectionalStream` / `WebTransportReceiveStream` / `WebTransportSendStream` / `WebTransportSendGroup` / `WebTransportDatagramDuplexStream` の存在                                                                                                                      |
| WebTransport         | 18     | `ready` / `closed` / `close` / `draining` / `reliability` / `congestionControl` / `protocol` / `responseHeaders` / `anticipatedConcurrentIncoming*` 2 件 / `datagrams` / `createBidirectionalStream` / `createUnidirectionalStream` / `incoming*Streams` 2 件 / `createSendGroup` / `getStats` / 静的 `supportsReliableOnly` |
| Datagrams            | 8      | `readable` / `writable` (deprecated 扱い) / `createWritable` / `maxDatagramSize` / `incomingMaxAge` / `outgoingMaxAge` / `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`                                                                                                                                     |
| Bidirectional Stream | 2      | `readable` / `writable`                                                                                                                                                                                                                                                                                                      |
| Send Stream          | 3      | `sendOrder` / `sendGroup` / `getStats`                                                                                                                                                                                                                                                                                       |
| Receive Stream       | 1      | `getStats`                                                                                                                                                                                                                                                                                                                   |
| Send Group           | 1      | `getStats`                                                                                                                                                                                                                                                                                                                   |
| Error                | 2      | `source` / `streamErrorCode`                                                                                                                                                                                                                                                                                                 |

判定は `hasGlobal` / `hasOnProto` / `hasOnStatic` の 3 つだけであり、いずれも「名前が存在するか」しか見ない。サマリ (`StaticApiSupportPanel.tsx:11` の `computeSummary`) は deprecated 項目だけを母集団から除き、それ以外は「存在すれば対応」と数える。

### 2.2 BCD テーブル (11 項目)

`bcd.ts:30` の `bcdSupportEntries` が Chrome / Firefox / Safari の対応開始バージョンだけを持ち、`BcdBadges.tsx:7` が「Chrome: 97+」または「Chrome: -」を表示する。確認日は `bcd.ts:28` の `BCD_CONFIRMED_DATE = "2026-08-05"`。

対象は §6.9 / §5.3 / §6.11 の設定 11 項目 (`allowPooling` / `requireUnreliable` / `congestionControl` / `serverCertificateHashes` / `anticipatedConcurrentIncoming*` 2 件 / `sendOrder` / `incomingMaxAge` / `outgoingMaxAge` / `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`)。

### 2.3 接続後の実行時チェック

`connect()` は `await wt.ready` の後に `signals.ts:772` で `wtApiSupport` ツリーを作り、`ConnectionPanel.tsx:532` で表示する。ツリーのキーは 12 個である。

- `datagrams` (子: `readable` / `writable` / `createWritable`)
- `incomingBidirectionalStreams` / `incomingUnidirectionalStreams`
- `createBidirectionalStream` / `createUnidirectionalStream`
- `closed` / `ready` / `draining`
- `reliability` / `congestionControl` / `protocol` / `getStats`

このツリーは値を `typeof` で整形して出すだけで、`getStats` は「function」と表示するだけで呼び出さない。

### 2.4 設定の入力検証

`params.ts` が次を検証する。

| 対象                                                            | 関数                                           | 検証内容                                                             |
| --------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `headers`                                                       | `parseHeadersText` (`params.ts:69`)            | Fetch の forbidden request-header と `wt-available-protocols` を拒否 |
| `protocols`                                                     | `parseProtocolsText` (`params.ts:99`)          | 空要素・重複・512 文字超を拒否                                       |
| `anticipatedConcurrentIncoming*`                                | `parseAnticipatedStreams` (`params.ts:119`)    | 0〜65535 の整数                                                      |
| `allowPooling` と `serverCertificateHashes`                     | `validateConnectionSettings` (`params.ts:134`) | 同時指定を拒否                                                       |
| `incomingMaxAge` / `outgoingMaxAge`                             | `parseDatagramMaxAge` (`params.ts:144`)        | 負値・NaN を拒否、0 は null                                          |
| `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams` | `parseMaxBufferedDatagrams` (`params.ts:159`)  | 整数に限り、1 未満を 1 にクランプ                                    |
| `sendOrder`                                                     | `parseSendOrder` (`params.ts:171`)             | 整数のみ                                                             |
| `closeCode`                                                     | `parseCloseCode` (`params.ts:183`)             | 0〜4294967295 の整数                                                 |

### 2.5 操作と表示

- 双方向ストリームの作成・送受信・close、送信単方向ストリームの作成・送信・close、受信単方向ストリームの受信 (作成・送信・close は無い)
- datagram の送受信
- `closed` の結果 (`closeCode` / `reason` / エラーメッセージ) の表示 (`closedOutcome.ts`)
- `ready` / `closed` / `draining` の Promise 状態の表示
- `reliability` / `congestionControl` / `supportsReliableOnly` / `protocol` / `responseHeaders` の表示
- `reliability` から HTTP/2 / HTTP/3 を推定するバッジ (`src/httpVersion.ts:13` の `toHttpVersionLabel`)

## 3. 足りていない判定

### 3.1 静的チェックに無い API

CR の IDL に存在するが `detectStaticApiSupport()` に無いもの。静的チェックは存在確認でよいため、ここでの不足は「一覧に無いこと」であり、動作確認の欠落ではない。BCD の値は 2026-10-31 時点の `main`、実測は Playwright 同梱ブラウザでの結果である。

| #   | API                                                 | 節    | MDN           | BCD (Chrome / Firefox / Safari) | 実測                                      | 影響                                                                                    |
| --- | --------------------------------------------------- | ----- | ------------- | ------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `WebTransport.prototype.exportKeyingMaterial`       | §6.4  | あり (実験的) | false / 155 / false             | Chromium なし、Firefox あり、WebKit あり  | ブラウザ差が大きいのに、対応状況が一切見えない                                          |
| 2   | `WebTransportDatagramsWritable` (グローバル)        | §4    | あり          | false / 155 / 26.4              | Chromium なし、Firefox あり、WebKit あり  | `createWritable()` の戻り値の型。新旧 API の判別に必要                                  |
| 3   | `WebTransportDatagramsWritable.prototype.sendGroup` | §4.2  | あり          | false / 155 / 26.4              | 同上                                      | datagram の送信順序を group で制御できるかが分からない                                  |
| 4   | `WebTransportDatagramsWritable.prototype.sendOrder` | §4.2  | あり          | false / 155 / 26.4              | 同上                                      | datagram の strict ordering を設定できるかが分からない                                  |
| 5   | `WebTransportWriter` (グローバル)                   | §11   | なし (404)    | BCD にエントリ無し              | Chromium なし、Firefox なし、WebKit あり  | 新しい writer の有無が分からない                                                        |
| 6   | `WebTransportWriter.prototype.atomicWrite`          | §11.1 | なし          | BCD にエントリ無し              | WebKit のみあり                           | flow control 不足時の reject を試せるかが分からない                                     |
| 7   | `WebTransportWriter.prototype.commit`               | §11.1 | なし          | BCD にエントリ無し              | WebKit のみあり                           | abort 時の committed offset 制御が使えるかが分からない                                  |
| 8   | `WebTransportSendStream.prototype.getWriter`        | §7.2  | あり          | false / 114 / 26.4              | Chromium なし、Firefox / WebKit あり      | 戻り値が `WebTransportWriter` かどうかの判定に必要                                      |
| 9   | `WebTransportError` コンストラクタ                  | §12.2 | あり          | 97 / 114 / 26.4                 | すべてあり (`source` の既定は `"stream"`) | 静的チェックは prototype の属性しか見ておらず、`new WebTransportError()` を試していない |

補足:

- `WebTransportSendStream.getWriter` は `in` 演算子では判定できない。`WebTransportSendStream` は `WritableStream` を継承するため、上書きされていなくても `WritableStream.prototype.getWriter` が `in` で真になる。判定するなら `WebTransportWriter` の存在確認、または `WebTransportSendStream.prototype.getWriter` が `WritableStream.prototype.getWriter` と異なることの確認が必要である。
- 同じ理由で、`WebTransportReceiveStream.getStats` のように派生インターフェース固有のメンバーは `in` で判定できるが、継承元にも同名メンバーがある場合は誤判定になる。
- `datagramsReadableType` (§6.9) は辞書メンバーなのでプロトタイプには現れない。効果の判定は `wt.datagrams.readable.getReader({ mode: "byob" })` が成功するかで行うほかない。
- BYOB リーダー (datagrams は §5.4、receive stream は §9) は BCD に `byob_readers` があり (datagrams: 109 / false / 26.4)、実装差が大きい。devtools は BYOB を一度も使っていない。
- `Transferable` (§4 / §7 / §9) と `Serializable` (§12) は、`structuredClone()` や `postMessage()` の transfer list でしか確認できない。静的チェックの対象外であることは妥当だが、判定項目としては欠けている。なお CR の `WebTransportDatagramsWritable` は `[Transferable]` だが transfer steps の定義が本文に無く、移送可否は仕様上も不明である (§9 の不明点)。
- 辞書 (`WebTransportOptions` / `WebTransportCloseInfo` / `WebTransportSendOptions` / `WebTransportSendStreamOptions` / `WebTransportHash`) と enum (`WebTransportReliabilityMode` / `WebTransportCongestionControl` / `WebTransportErrorSource`) はプロトタイプに現れないため、静的チェックでは検出できない。効果は実行時のプロパティ表示 (§3.4 の箇条書き) と BYOB の可否で間接的に判定するしかなく、独立した判定項目としては未整理である。
- `incomingHighWaterMark` / `outgoingHighWaterMark` は CR から削除済みで MDN も非推奨 + 非標準としている。`writable` は deprecated として判定しているのに、この 2 つを判定していないのは一貫していない (優先度は低い)。

### 3.2 接続後にのみ検証できる API (任意の実行時チェック)

次の機能は接続してはじめて意味を持つ。§1.4 の落とし所に従い、静的パネルの判定・サマリには含めず、接続成功時だけ実行する任意のチェックとする。サーバーを用意できない環境では未検証のままとする。`wtApiSupport` ツリーは「値の型を表示する」だけであり、次の機能は実行も検証もされていない。

| 対象                                                                                                              | 仕様                                      | 現状                                                                                                                                                                                                     | 追加する判定                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incomingBidirectionalStreams`                                                                                    | §6.2 `pullBidirectionalStream`            | 静的チェックとツリーの値表示のみ。リーダーを付けていない                                                                                                                                                 | 受信した双方向ストリームを一覧表示し、サーバー起点のストリームを読めるか確認する                                                                                                                                                                                                                                        |
| `getStats()`                                                                                                      | §6.4、§6.13、§6.14                        | 存在チェックと「function」表示のみ                                                                                                                                                                       | 呼び出して `WebTransportConnectionStats` と `WebTransportDatagramStats` の値を表示する。Firefox は partial で呼ぶと not-implemented エラーになるため、存在だけでは不十分。`bytesSentOverhead` / `bytesAcknowledged` (at risk、absent の可能性) と `estimatedSendRate` (`null` 許容) / `atSendCapacity` の有無も確認する |
| `WebTransportSendStream.getStats()` / `WebTransportReceiveStream.getStats()` / `WebTransportSendGroup.getStats()` | §7.2、§9.1、§8.1 (統計辞書は §7.6 / §9.5) | 静的チェックのみ                                                                                                                                                                                         | 各ストリームで呼び出して `bytesWritten` / `bytesSent` / `bytesAcknowledged` / `bytesReceived` / `bytesRead` を表示する                                                                                                                                                                                                  |
| `createSendGroup()` と `sendGroup`                                                                                | §6.4、§4.2、§7.1                          | 静的チェックのみ。group を生成していない                                                                                                                                                                 | group を生成し、`sendGroup` を設定したストリーム / datagram の送信順序を確認する。別の transport の group を属性に設定したときの `InvalidStateError`、オプションで渡したときの `TypeError` も判定する                                                                                                                   |
| `sendOrder` の事後設定                                                                                            | §7.1、§4.2                                | 作成時オプションのみ。getter / setter を試していない                                                                                                                                                     | ストリーム作成後に `sendOrder` / `sendGroup` を読み書きする                                                                                                                                                                                                                                                             |
| `waitUntilAvailable`                                                                                              | §6.12                                     | ストリーム作成時にオプションとして渡すだけ (`signals.ts:999`、`signals.ts:1133`)                                                                                                                         | flow control の枯渇時に作成が `QuotaExceededError` で reject されるか (true なら待機するか) を判定する                                                                                                                                                                                                                  |
| `new WebTransport()` の例外条件                                                                                   | §6.2                                      | グローバルの存在確認のみ                                                                                                                                                                                 | `https` 以外・fragment 付きで `SyntaxError`、`allowPooling` と `serverCertificateHashes` の同時指定で `NotSupportedError`、`wt-available-protocols` ヘッダーで `TypeError` になるかを判定する                                                                                                                           |
| `maxDatagramSize`                                                                                                 | §5.3                                      | 存在チェックのみ。値を表示していない                                                                                                                                                                     | 実際の値を表示し、送信する datagram のサイズと比較する                                                                                                                                                                                                                                                                  |
| `WebTransportWriter.atomicWrite()` / `commit()`                                                                   | §11.1                                     | 未使用                                                                                                                                                                                                   | 作成した送信ストリームの writer で呼び出し、reject 条件を確認する                                                                                                                                                                                                                                                       |
| `exportKeyingMaterial()`                                                                                          | §6.4                                      | 未使用                                                                                                                                                                                                   | `label` / `context` / `outputLength` を渡して `Uint8Array` が返るか、`RangeError` 条件が正しいかを確認する                                                                                                                                                                                                              |
| `WebTransportError.source` / `streamErrorCode`                                                                    | §12.3                                     | 静的チェックのみ。実行時のエラーで表示していない                                                                                                                                                         | ストリームの abort / reset 時に `source` と `streamErrorCode` を表示する                                                                                                                                                                                                                                                |
| `close()` (state が `connecting` のとき)                                                                          | §6.4                                      | 不可。`transport` への代入は `await wt.ready` の後だけであり、`disconnect()` は `transport` が null のとき `close()` を呼ばない (状態と設定のリセットは無条件に実行する)。ボタンも `connecting` 中は無効 | 接続中の `close()` を呼べるようにする                                                                                                                                                                                                                                                                                   |
| ストリームの abort / cancel                                                                                       | §3.2 (abort sending / abort receiving)    | 未使用。`writer.close()` と `reader.releaseLock()` のみ                                                                                                                                                  | `writer.abort()` と `reader.cancel()` を操作として提供する                                                                                                                                                                                                                                                              |
| `WebTransportError` の serialization                                                                              | §12.4                                     | 未使用                                                                                                                                                                                                   | `structuredClone()` で `source` / `streamErrorCode` が保持されるか確認する                                                                                                                                                                                                                                              |

### 3.3 BCD テーブルの不足・陳腐化

2026-11-01 時点の BCD (`main`) と `bcd.ts` を突き合わせた結果である。

#### 3.3.1 食い違い (2 件)

| 項目                                     | `bcd.ts`        | BCD       | 備考                                                                          |
| ---------------------------------------- | --------------- | --------- | ----------------------------------------------------------------------------- |
| `incomingMaxBufferedDatagrams` の Safari | `null` (未対応) | `preview` | BCD は 2026-08-18 の commit `d4a875c258` で `false` から `preview` に更新済み |
| `outgoingMaxBufferedDatagrams` の Safari | `null` (未対応) | `preview` | 同上                                                                          |

Chrome / Firefox の値は 11 項目すべて一致した。ただし `bcd.ts` の `null` は BCD の `version_added: false` と同義であり、`preview` (Technology Preview / Nightly のみ) を表現できない。

#### 3.3.2 未収録 (1 件)

- `protocols` (§6.9): BCD の `api.WebTransport.WebTransport.options_protocols_parameter` にエントリが追加済み (2026-08-28、Chrome 143 / Firefox 155 / Safari 26.4)。`ConnectionPanel.tsx:283` に `protocols` の入力欄があるのにバッジが無い。`bcd.ts:9` のコメントは「protocols は BCD にエントリが無い」としており、陳腐化している。

#### 3.3.3 表現できない属性

`BcdSupportEntry` は `chrome` / `firefox` / `safari` のバージョン文字列または `null` しか持たないため、BCD の次の情報が UI に反映されない。

- `experimental`: 4 項目 (`anticipatedConcurrentIncoming*` 2 件、`incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`) が experimental であるのに、緑の「対応」バッジで表示される
- `preview`: Safari Technology Preview のみの対応を「-」と誤表示する
- `partial_implementation` / `notes`: `createUnidirectionalStream` が Firefox で partial (戻り値が `WritableStream`) であることが出ない。`getStats` も Firefox で partial (呼ぶと not-implemented エラー) だが、`bcd.ts` の 11 項目に含まれていないため、まずバッジ対象に加える必要がある
- `sendOrder` の対応先: BCD には生成オプション (Firefox 119)、`WebTransportSendStream.sendOrder` (Firefox 121)、`WebTransportDatagramsWritable.sendOrder` (Firefox 155) の 3 つがあるが、`bcd.ts` は 1 行しか持たず、名前からどれを指すか決まらない
- `anticipatedConcurrentIncoming*`: BCD の feature は `WebTransport` の属性であり、§6.9 のコンストラクタ option ではない。設定項目のバッジとして流用していることはコメントで明示する必要がある

#### 3.3.4 デッドデータ

`bcd.ts` の `sendOrder` を参照する `BcdBadges` は存在しない。`BidiStreamPanel.tsx` と `UniSendStreamPanel.tsx` の `sendOrder` 入力欄にはバッジが無く、`bcd.ts` の 11 項目のうち `sendOrder` だけが UI 未使用である。

#### 3.3.5 その他

- 確認日 `2026-08-05` は 2026-11-01 時点で約 3 か月前。2026-08-17 以降の BCD 更新 (Firefox 155 の `createWritable` / `createSendGroup` / `sendGroup` / `WebTransportDatagramsWritable`、Safari TP 250/251、Chrome 157 beta の `reliability` / `responseHeaders` / `supportsReliableOnly`、`protocols` 追加) が反映されていない。
- BCD には `api.WebTransport.local_network_access` (Chrome 147 以降、`experimental`) がある。Chrome 147 以降は WebTransport が Local Network Access の制約を受けるため、既定の接続先 `https://127.0.0.1:4443/wt` への接続が LNA で失敗する可能性がある。devtools のエラー判定は LNA を考慮していない (本調査ではサーバーを用意できず実挙動は未検証)。

### 3.4 設定検証の不足

| 対象                                                            | 仕様の制約                                                                                                                                         | 現状                                                          | 不足                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocols`                                                     | §6.2: 重複・空・isomorphic encoded length が 0 または 512 超に加え、「negotiated application protocol の要素の要件」を満たさない場合 `SyntaxError` | 重複・空・512 超のみ                                          | 文字種の検証が無い。構造化ヘッダーの文字列として不正な値 (タブ、非 ASCII など) は接続時に `SyntaxError` になるまで分からない                                                                                             |
| `sendOrder`                                                     | §6.11 `long long`                                                                                                                                  | 整数のみ                                                      | `long long` の範囲を超える値を弾かない。WebIDL の変換で巡回するため、入力と実際の値が一致しない                                                                                                                          |
| `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams` | §5.3 `unsigned long`                                                                                                                               | 整数に限り 1 未満を 1 にクランプ                              | `unsigned long` の上限 (4294967295) 超を弾かない。範囲外は WebIDL の変換で巡回する                                                                                                                                       |
| `close()` の `reason`                                           | §6.4 step 6: UTF-8 で 1024 byte を超える部分を切り詰める                                                                                           | `trim()` して渡すが、UTF-8 の 1024 byte 切り詰めは行わない    | 切り詰めが起きることを表示・警告していない                                                                                                                                                                               |
| `serverCertificateHashes`                                       | §6.9: `sequence<WebTransportHash>` (複数指定可)、`algorithm` は `sha-256`、`value` は DER 証明書の SHA-256 (32 byte)                               | 単一ハッシュのみ、`sha-256` 固定、Base64 の復号長を検証しない | 32 byte 以外のハッシュを渡してもそのまま接続し、ハンドシェイク失敗の原因が分かりにくい。複数ハッシュ (証明書ローテーション) を試せない                                                                                   |
| `WebTransportOptions.url`                                       | §6.2: URL parse 失敗、`https` 以外、fragment 付きは `SyntaxError`                                                                                  | 事前検証なし                                                  | 接続時に例外メッセージで分かるが、入力段階の判定が無い                                                                                                                                                                   |
| 辞書メンバーの無視                                              | WebIDL: 辞書に無いメンバーは無視される                                                                                                             | 未考慮                                                        | `allowPooling` / `requireUnreliable` / `congestionControl` / `datagramsReadableType` / `protocols` / `headers` をブラウザが無視しても、接続は成功する。UI は「設定した」と表示するだけで、実際に効いたかを判定していない |

接続時オプションが効いたかどうかは、接続後の値と突き合わせれば判定できる。

- `requireUnreliable`: `reliability` が `"supports-unreliable"` になるか (HTTP/3 が使えない環境では接続自体が失敗するはずである)
- `congestionControl`: 同名プロパティが指定値 (または `"default"`) になるか
- `anticipatedConcurrentIncoming*`: 同名プロパティに設定値が入るか
- `protocols`: `protocol` にサーバーが選択した値が入るか
- `datagramsReadableType: "bytes"`: `datagrams.readable.getReader({ mode: "byob" })` が成功するか
- `allowPooling`: `getStats()` に pooled connection stats だけが含まれるか (仕様 §6.13 の Note)

`waitUntilAvailable` は `WebTransportSendStreamOptions` (§6.12) のメンバーであり接続オプションではない。flow control の枯渇時に `createBidirectionalStream()` / `createUnidirectionalStream()` が `QuotaExceededError` で reject されるかで判別する (§3.2)。

### 3.5 エラー系の判定欠落

- ストリームの読み取りループは `catch` で例外を握りつぶしている (`signals.ts:950`、`signals.ts:1046`)。仕様では送信 abort / 受信 abort 時に `WebTransportError` (`source` は `"stream"`、`streamErrorCode` あり) でストリームが error になる (§9.4、§7.5)。devtools はこの情報を一切表示しない。
- `closed` の reject 時は `error.message` だけを保存し (`closedOutcome.ts:38`)、`WebTransportError` の `name` / `source` / `streamErrorCode` を保存していない。接続失敗、network error、server 起因の異常終了の区別ができない。
- ストリーム作成・送信の失敗は `console.error` に流すだけで (`signals.ts:1020` ほか)、UI には出ない。
- datagram 送信で `createWritable()` が無い場合は `console.error` のみ (`signals.ts:1232`)。

## 4. 誤っている・誤解を招く判定

### 4.1 `supportsReliableOnly` をインスタンスから読んでいる

`signals.ts:722` は `wtAny.supportsReliableOnly` を読むが、CR §6.3 の IDL は `static readonly attribute boolean supportsReliableOnly` であり、値はコンストラクタ `WebTransport.supportsReliableOnly` にしか無い (静的チェック `signals.ts:304` は正しく `hasOnStatic` を使っている)。実測では WebKit で `WebTransport.supportsReliableOnly === true` かつ `wt.supportsReliableOnly === undefined` であり、実行時の表示は常に `N/A` になる。

### 4.2 接続失敗時の状態表示

`wt.closed` の reject ハンドラは `connectionError` を設定した後に `disconnect()` を呼ぶ (`signals.ts:691`)。`disconnect()` は `connectionStatus` を `disconnected` に戻す (`signals.ts:834`)。接続ハンドシェイクが失敗すると `ready` と `closed` の両方が reject されるため、最終的に `connectionStatus` が `disconnected` になり得る。実測 (Chromium 156、接続拒否) では最終状態が次のようになった。

- `connectionStatus`: `disconnected` (`error` ではない)
- `connectionError`: `Opening handshake failed.` (保持はされている)
- `wtReadyState`: `rejected: Opening handshake failed.`
- `wtClosedState`: `pending` (reject 後に `disconnect()` がリセットするため)
- 結果として `ConnectionPanel.tsx:461` の詳細表示は `disconnected` の間は出ず、「Disconnected」と表示される

接続失敗と利用者操作の切断が同じ表示になり、失敗理由は `closed-outcome` の箱にしか残らない。判定としては「失敗」を明示すべきである。

### 4.3 存在確認だけでは動作を保証しない

- Firefox は `getStats` が partial 実装で、メソッドは存在するが呼ぶと not-implemented エラーになる (BCD の注記、実測でも `NS_ERROR_NOT_IMPLEMENTED`)。存在確認としては [OK] で正しいが、「All Supported」の語が動作を保証するように読めるのが問題である。静的パネルが存在確認であることを明記し、partial は BCD の `notes` として表示する (または接続後の任意チェックで検出する)。
- Firefox の `createUnidirectionalStream()` は partial で、戻り値が `WebTransportSendStream` ではなく `WritableStream` になる (BCD の注記)。静的チェックは [OK] を表示する。
- `congestionControl` は feature at risk であり、`"low-latency"` を指定しても UA が対応していなければ `"default"` に落とされる (§6.2 step 11、§6.9 の at risk 注記)。UI は指定値をそのまま使い、結果が `default` でも警告しない。

### 4.4 グローバル欠落の意味

Chrome 156 は `WebTransportSendStream` / `WebTransportReceiveStream` / `WebTransportSendGroup` / `WebTransportDatagramsWritable` のグローバルを公開しない (BCD で `version_added: false`)。また `createBidirectionalStream()` の `readable` / `writable` は汎用の `ReadableStream` / `WritableStream` を返す (BCD の `returns_WebTransportReceiveStream` / `returns_WebTransportSendStream` が `false`)。

静的チェックはグローバル 4 件を [NG] と表示するが、`WebTransportBidirectionalStream.prototype.readable` / `writable` の 2 属性は Chrome でも [OK] である。API の存在から、汎用ストリームを使った操作は動作することが期待できる (WebTransport サーバーを用意していないため実測はしていない)。表示だけを見ると「ストリーム機能が無い」と誤読されるため、グループの説明に「型付きインターフェースの有無」であることを明記すべきである。

### 4.5 HTTP/2 / HTTP/3 判別

`toHttpVersionLabel` (`src/httpVersion.ts:13`) は `reliability` の値だけで HTTP バージョンを推定する。Chrome 156 は `reliability` 未実装 (BCD: Chrome 157 から) なので、接続できていても常に `--` になる。`--` は「未確立」の意味で定義されているため、接続済みなのに未確立と表示される。`reliability` が無い環境では `Unknown (reliability unavailable)` のような別表示が必要である。

### 4.6 `writable` と `createWritable` の個別判定

`writable` は CR から削除され (polyfill の Note のみ)、MDN では非推奨 + 非標準、BCD でも deprecated である。一方 `createWritable()` は現行 API である。実装は Chrome が `writable` のみ、Safari が `createWritable()` のみという相互補完の関係にあり、`sendDatagram()` は両方をフォールバックで使っている。静的チェックは `writable` を deprecated として母集団から外すため、Chrome では「datagram 送信は利用可能」であることがサマリに反映されず、`createWritable` の [NG] だけが目立つ。この 2 項目は「datagram 送信 API のどちらかが使えるか」という 1 つの判定にまとめるべきである。

### 4.7 「All Supported」の意味

サマリの「All Supported (41 / 41)」は、deprecated の `writable` を除いた 41 項目がすべて存在するという意味でしかない (`StaticApiSupportPanel.tsx:18` が deprecated を母集団から除き、`StaticApiSupportPanel.tsx:54` が「41 / 41」を表示する。42 という数字は生のチェック項目数であり、サマリの分母ではない)。

母集団に入っていないのは、3.1 の 9 項目、BYOB リーダー、Transferable / Serializable、統計の値の取得、実行時のエラー詳細 (`source` / `streamErrorCode` の値) である。`getStats` 4 件の名前と `WebTransportError` の `source` / `streamErrorCode` の名前は 42 項目に含まれるが、実際に呼べるか、どんな値を返すかは判定していない。表示に「この一覧は devtools が使う API の一部であり、存在確認にすぎない」旨の注記が必要である。サマリの文言も `All Supported` ではなく `All Present` のような存在確認を示す語にするのが落とし所である。

## 5. ブラウザ実測結果

2026-11-01 時点の Playwright 同梱ブラウザで観測した。○ は存在、× は不在、値は特記がある場合のみ示す。

| 項目                                                                                                               | Chromium 156                             | Firefox 157                     | WebKit (Playwright) 27.2 |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------- | ------------------------ |
| `WebTransport` / `WebTransportError` / `WebTransportBidirectionalStream` / `WebTransportDatagramDuplexStream`      | ○                                        | ○                               | ○                        |
| `WebTransportReceiveStream` / `WebTransportSendStream` / `WebTransportSendGroup` / `WebTransportDatagramsWritable` | × (グローバル非公開。ストリーム操作は可) | ○                               | ○                        |
| `WebTransportWriter`                                                                                               | ×                                        | ×                               | ○                        |
| `draining` / `reliability` / `congestionControl` / `responseHeaders`                                               | ×                                        | ○ (うち `responseHeaders` は ×) | ○                        |
| `anticipatedConcurrentIncoming*`                                                                                   | ×                                        | ×                               | ○                        |
| `createSendGroup` / `getStats` / `exportKeyingMaterial`                                                            | ×                                        | ○ (`getStats` は呼ぶとエラー)   | ○                        |
| `WebTransport.supportsReliableOnly` (静的)                                                                         | なし                                     | なし (BCD: Firefox 158)         | `true`                   |
| `datagrams.readable` / `maxDatagramSize` / `incomingMaxAge` / `outgoingMaxAge`                                     | ○ / 1024 / null / null                   | ○ / 1024 / Infinity / Infinity  | ○ / 1024 / null / null   |
| `datagrams.writable` / `createWritable()`                                                                          | ○ / ×                                    | ○ / ○                           | × / ○                    |
| `datagrams.incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`                                          | ○ / ○ (初期値 1)                         | × / ×                           | ○ / ○ (初期値 1)         |
| `WebTransportSendStream.sendOrder` / `sendGroup` / `getStats` / `getWriter`                                        | ×                                        | ○ / ○ / ○ / ○                   | ○ / ○ / ○ / ○            |
| `WebTransportWriter.atomicWrite()` / `commit()`                                                                    | ×                                        | ×                               | ○                        |
| `WebTransportError.source` / `streamErrorCode` / `new WebTransportError()`                                         | ○ / ○ / ○                                | ○ / ○ / ○                       | ○ / ○ / ○                |

注意: WebKit は Playwright の trunk 相当であり、Safari 安定版より先行して `exportKeyingMaterial` や `WebTransportWriter` を持っている可能性がある。ブラウザ対応の判断は BCD を優先し、実測は「この環境で何が動くか」の参考値として扱うこと。

## 6. 優先度付き対応案

§1.4 の役割分担に従い、接続不要で直せるものと、接続成功時だけ意味があるものに分ける。P0 / P1 は実装済みであり、検証結果は付録 D に示す。

### P0: 接続を使わずに直す誤判定 (対応済み)

| #   | 内容                                                                                                                                                      | 対象                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `supportsReliableOnly` を `WebTransport.supportsReliableOnly` (静的) から読む                                                                             | `signals.ts:722`                                               |
| 2   | 接続失敗時に `Disconnected` ではなく `Error` を表示し、`ready` / `closed` の状態を保持する。`closed` ハンドラからの `disconnect()` を成功時だけに限定する | `signals.ts:683`、`signals.ts:804`、`ConnectionPanel.tsx:461`  |
| 3   | `reliability` が無い環境向けに HTTP バージョン判別の `--` の意味を分離する                                                                                | `src/httpVersion.ts:13`、`ConnectionPanel.tsx:30`              |
| 4   | 静的パネルのサマリを `All Present` など存在確認を示す語に変更し、「動作は保証しない」注記を追加する。deprecated を除いた分母 (41) も正しく表示する        | `StaticApiSupportPanel.tsx:11`、`StaticApiSupportPanel.tsx:54` |

### P1: 存在確認の網羅性と正確性 (接続不要・対応済み)

3.1 の 1〜9 を存在確認として追加する。`WebTransportDatagramsWritable` と `WebTransportWriter` はグローバルとして、`sendGroup` / `sendOrder` / `atomicWrite` / `commit` はプロトタイプメンバーとして追加する。`WebTransportError` のコンストラクタは、ネットワークを使わない `new WebTransportError()` と既定値 (`source` / `streamErrorCode`) の確認まで行う。

`getWriter` は継承の影響で `in` 演算子では判定できないため、`WebTransportWriter` の存在かプロトタイプの同一性で判定する。あわせて `writable` / `createWritable` を「datagram 送信 API のどちらか」という対の判定にする。

BCD テーブルも接続不要で直せる。

- `protocols` を追加する (Chrome 143 / Firefox 155 / Safari 26.4)
- Safari の `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams` を `preview` として表示する
- `experimental` / `partial_implementation` / `notes` を表現できる型に拡張する
- 確認日を更新し、`protocols` のコメントの陳腐化を直す
- `sendOrder` のデッドデータを削除するか、ストリーム作成パネルにバッジを付ける

入力検証も接続不要なので P1 に含める。`protocols` の文字種、`sendOrder` の `long long` 範囲、`maxBufferedDatagrams` の `unsigned long` 範囲、`reason` の 1024 byte 切り詰め、証明書ハッシュの 32 byte と複数指定を検証する。

### P2: 接続成功時だけの任意チェック (未対応。接続先が必要)

サーバーを用意できない環境では未検証のままにする。静的パネルの判定やサマリには含めない。

- `getStats()` の呼び出しと統計の表示 (connection / datagram / send stream / receive stream / send group)。at risk の `bytesAcknowledged`、`null` を許容する `estimatedSendRate` を含む
- `incomingBidirectionalStreams` の受信と表示
- `createSendGroup()` と `sendGroup` / `sendOrder` の設定・取得
- `WebTransportWriter` の `atomicWrite()` / `commit()`
- `exportKeyingMaterial()` の呼び出し
- ストリームの abort / cancel 操作と、`WebTransportError.source` / `streamErrorCode` の表示
- `close()` (state が `connecting` のとき) のサポート
- BYOB リーダーと `datagramsReadableType: "bytes"` の効果判定
- `maxDatagramSize` の表示と、超過する datagram の警告 (仕様では超過 write は resolve され、UA が黙って捨てる)
- `new WebTransport()` の例外条件 (`SyntaxError` / `NotSupportedError` / `TypeError`) の判定
- 辞書メンバーが無視されていないかの判定 (実行後のプロパティ値と設定値の突き合わせ)

### P3: テストと保守 (一部対応: テスト追加と README 更新を実施。IDL 同期手順は未着手)

- `detectStaticApiSupport()` と `bcd.ts` の単体テストを追加する (現在のテストは `params.test.ts` (入力検証)、`closedOutcome.test.ts` (終了結果)、`messageLog.test.ts` (ログ) であり、静的チェックと BCD テーブルのテストは無い)。存在確認は接続不要なので CI で回せる
- 静的チェックの一覧を CR の IDL から機械的に生成するか、少なくとも IDL のバージョンを明記して同期手順を決める (今回の欠落は手書きの一覧が陳腐化した実例である)
- README の webtransport-devtools の説明を、実際に判定している範囲 (存在確認) に合わせる

## 7. 出典

- W3C WebTransport Candidate Recommendation Snapshot, 30 July 2026: https://www.w3.org/TR/webtransport/
- W3C WebTransport Editor's Draft (2026-11-01 取得): https://raw.githubusercontent.com/w3c/webtransport/main/index.bs
- MDN WebTransport API: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API
- MDN content (2026-10-31): https://github.com/mdn/content
- MDN Browser Compat Data (2026-10-31): https://github.com/mdn/browser-compat-data
- WebTransport Protocol Framework: https://datatracker.ietf.org/doc/html/draft-ietf-webtrans-overview
- Fetch forbidden request-header: https://fetch.spec.whatwg.org/#forbidden-request-header
- Web IDL (辞書・整数変換・列挙): https://webidl.spec.whatwg.org/
- Streams Standard (BYOB リーダー): https://streams.spec.whatwg.org/
- Local Network Access と WebTransport の統合 (BCD 記載): https://wicg.github.io/local-network-access/#integration-with-webtransport
- WebTransport over HTTP/3: https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- WebTransport over HTTP/2: https://datatracker.ietf.org/doc/draft-ietf-webtrans-http2/

## 付録 A. 静的チェック 42 項目と CR IDL の対応

| グループ             | 項目                                               | CR 上の対応     | 備考                                           |
| -------------------- | -------------------------------------------------- | --------------- | ---------------------------------------------- |
| Global               | WebTransport                                       | §6 interface    | コンストラクタの実動作は未判定                 |
| Global               | WebTransportError                                  | §12 interface   | コンストラクタは未判定                         |
| Global               | WebTransportBidirectionalStream                    | §10 interface   |                                                |
| Global               | WebTransportReceiveStream                          | §9 interface    | Chrome はグローバル非公開                      |
| Global               | WebTransportSendStream                             | §7 interface    | Chrome はグローバル非公開                      |
| Global               | WebTransportSendGroup                              | §8 interface    |                                                |
| Global               | WebTransportDatagramDuplexStream                   | §5 interface    |                                                |
| WebTransport         | ready                                              | §6.3            |                                                |
| WebTransport         | closed                                             | §6.3            |                                                |
| WebTransport         | close                                              | §6.4            | `connecting` 中の呼び出しは未対応              |
| WebTransport         | draining                                           | §6.3            |                                                |
| WebTransport         | reliability                                        | §6.3            |                                                |
| WebTransport         | congestionControl                                  | §6.3            |                                                |
| WebTransport         | protocol                                           | §6.3            |                                                |
| WebTransport         | responseHeaders                                    | §6.3            | MDN 未文書、experimental                       |
| WebTransport         | anticipatedConcurrentIncomingUnidirectionalStreams | §6.3            | MDN 未文書、experimental                       |
| WebTransport         | anticipatedConcurrentIncomingBidirectionalStreams  | §6.3            | MDN 未文書、experimental                       |
| WebTransport         | datagrams                                          | §6.3            |                                                |
| WebTransport         | createBidirectionalStream                          | §6.4            |                                                |
| WebTransport         | createUnidirectionalStream                         | §6.4            | Firefox は partial (戻り値が `WritableStream`) |
| WebTransport         | incomingBidirectionalStreams                       | §6.3            | リーダー未使用                                 |
| WebTransport         | incomingUnidirectionalStreams                      | §6.3            |                                                |
| WebTransport         | createSendGroup                                    | §6.4            | 未使用                                         |
| WebTransport         | getStats                                           | §6.4            | 未呼び出し                                     |
| WebTransport         | supportsReliableOnly (静的)                        | §6.3            | 実行時表示はインスタンスから読んでおり誤り     |
| Datagrams            | readable                                           | §5.3            |                                                |
| Datagrams            | writable                                           | CR から削除済み | MDN 非推奨 + 非標準                            |
| Datagrams            | createWritable                                     | §5.2            | オプション `sendOrder` / `sendGroup` は未使用  |
| Datagrams            | maxDatagramSize                                    | §5.3            | 値の表示なし                                   |
| Datagrams            | incomingMaxAge                                     | §5.3            |                                                |
| Datagrams            | outgoingMaxAge                                     | §5.3            |                                                |
| Datagrams            | incomingMaxBufferedDatagrams                       | §5.3            | MDN 未文書、experimental                       |
| Datagrams            | outgoingMaxBufferedDatagrams                       | §5.3            | MDN 未文書、experimental                       |
| Bidirectional Stream | readable                                           | §10.2           |                                                |
| Bidirectional Stream | writable                                           | §10.2           |                                                |
| Send Stream          | sendOrder                                          | §7.1            | 事後設定は未使用                               |
| Send Stream          | sendGroup                                          | §7.1            | 事後設定は未使用                               |
| Send Stream          | getStats                                           | §7.2            | 未呼び出し                                     |
| Receive Stream       | getStats                                           | §9.1            | 未呼び出し                                     |
| Send Group           | getStats                                           | §8.1            | 未呼び出し                                     |
| Error                | source                                             | §12.3           | 実行時の表示なし                               |
| Error                | streamErrorCode                                    | §12.3           | 実行時の表示なし                               |

未収録の API: `exportKeyingMaterial` (§6.4)、`WebTransportDatagramsWritable` (§4)、`WebTransportWriter` (§11)、`WebTransportSendStream.getWriter` (§7.2)、`WebTransportError` コンストラクタ (§12.2)、BYOB リーダー (§5.4 / §9)、`Transferable` / `Serializable` (§4 / §7 / §9 / §12)、`incomingHighWaterMark` / `outgoingHighWaterMark` (削除済み)。

## 付録 B. `bcd.ts` と BCD の突き合わせ

| `bcd.ts` の項目                                    | `bcd.ts` の値 (Chrome / Firefox / Safari) | BCD の値                             | 一致                                                            |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| allowPooling                                       | null / 114 / 26.4                         | false / 114 / 26.4                   | 一致                                                            |
| requireUnreliable                                  | null / 114 / 26.4                         | false / 114 / 26.4                   | 一致                                                            |
| congestionControl                                  | null / 114 / 26.4                         | false / 114 / 26.4                   | 一致                                                            |
| serverCertificateHashes                            | 100 / 125 / 26.4                          | 100 / 125 / 26.4                     | 一致                                                            |
| anticipatedConcurrentIncomingUnidirectionalStreams | null / null / 26.4                        | false / false / 26.4 (experimental)  | 値は一致、experimental 未反映                                   |
| anticipatedConcurrentIncomingBidirectionalStreams  | null / null / 26.4                        | false / false / 26.4 (experimental)  | 値は一致、experimental 未反映                                   |
| sendOrder                                          | null / 119 / 26.4                         | options: false / 119 / 26.4          | 値は一致。属性は Firefox 121、datagrams writable は Firefox 155 |
| incomingMaxAge                                     | 97 / 114 / 26.4                           | 97 / 114 / 26.4                      | 一致                                                            |
| outgoingMaxAge                                     | 97 / 114 / 26.4                           | 97 / 114 / 26.4                      | 一致                                                            |
| incomingMaxBufferedDatagrams                       | 151 / null / null                         | 151 / false / preview (experimental) | Safari が食い違い                                               |
| outgoingMaxBufferedDatagrams                       | 151 / null / null                         | 151 / false / preview (experimental) | Safari が食い違い                                               |

`bcd.ts` に無い設定項目で BCD にエントリがあるもの: `protocols` (Chrome 143 / Firefox 155 / Safari 26.4)。BCD にエントリが無いもの: `headers`、`datagramsReadableType`、`waitUntilAvailable`、`sendGroup` の設定オプション (`options_sendGroup`。属性の `WebTransportSendStream.sendGroup` と `WebTransportDatagramsWritable.sendGroup` にはエントリがある) (いずれも 2026-11-01 時点)。

## 付録 C. 調査の限界

- WebTransport サーバーを用意していないため、セッション確立後のネゴシエート値、`maxDatagramSize` の更新後の値、datagram の実送信と上限超過時の挙動、統計値、ストリーム abort 時の `WebTransportError` の内容は実測していない。仕様の記述に基づく指摘である。
- Local Network Access の挙動は、ブラウザで実際に検証していない。BCD の feature と既定接続先の組み合わせから指摘したものである。
- Playwright 同梱の WebKit は Safari 安定版と一致しない場合がある。ブラウザ対応の判断は BCD を優先した。
- CR と Editor's Draft には差分 (`responseHeaders` の `[SameObject]`、datagram の送信アルゴリズム) がある。本レポートは CR を基準にした。
- 仕様内の不整合 (例: `WebTransportBidirectionalStream` の creation 手続きに `sendGroup` が渡っていない、`[[Writables]]` への追加手順が CR に無い) は、devtools の判定とは独立の問題として扱い、本レポートの対象外とした。

## 付録 D. 実装内容と検証結果 (2026-11-01)

監査で指摘した P0 / P1 のうち、接続を使わずに直せる範囲を実装した。接続先の WebTransport サーバーは無いため、接続後の動作 (統計、サーバー起点ストリーム、writer、BYOB、datagram の実送信) は対象外とし、P2 に残した。

### D.1 実装内容

| 項目                            | 内容                                                                                                                                                                                                                                                                                                                                  | 主なファイル                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 静的判定の分離                  | `detectStaticApiPresence()` とサマリ計算を純粋モジュールに分離した。判定は 10 グループ 52 項目 (サマリの母集団は 50 項目)                                                                                                                                                                                                             | `devtools/src/webtransport-devtools/staticApiSupport.ts`              |
| 静的チェックの追加              | `exportKeyingMaterial`、`WebTransportDatagramsWritable` (と `sendGroup` / `sendOrder`)、`WebTransportWriter` (と `atomicWrite` / `commit`)、`WebTransportSendStream.getWriter`、`WebTransportError constructor` を追加した。`getWriter` は継承で `in` が常に真になるため、`WebTransportWriter` の存在とプロトタイプの同一性で判定する | 同上                                                                  |
| datagram 送信経路の対判定       | `writable` (deprecated) と `createWritable` のどちらかが使えるかを「Datagram send path」として 1 項目で判定する。`createWritable` は詳細行としてサマリの母集団から外す                                                                                                                                                                | 同上                                                                  |
| サマリの文言                    | `All Present` / `Partially Present` / `WebTransport Not Present` に変更し、「存在確認のみで動作は保証しない」注記を追加した。項目の表示も present / absent にした                                                                                                                                                                     | `components/StaticApiSupportPanel.tsx`                                |
| `supportsReliableOnly` の読み先 | インスタンスではなく `WebTransport.supportsReliableOnly` (静的) から読むようにした                                                                                                                                                                                                                                                    | `signals.ts`                                                          |
| 接続失敗時の状態                | セッション終了処理を分離し、`closed` の reject 時は `connectionStatus` を `error` にして失敗を明示する。`ready` / `closed` / `draining` の状態は失敗理由を残すためリセットしない                                                                                                                                                      | `signals.ts`                                                          |
| HTTP バージョン判別             | `reliability` が無い場合は `--` ではなく `N/A` (判定不能) と表示する                                                                                                                                                                                                                                                                  | `src/httpVersion.ts`、`components/ConnectionPanel.tsx`                |
| 証明書ハッシュの検証            | Base64 を復号して 32 byte (SHA-256) でなければ接続前に拒否する                                                                                                                                                                                                                                                                        | `params.ts`、`signals.ts`                                             |
| protocols の文字種              | RFC 8941 の string の制約 (ASCII 印字可能文字) を追加した                                                                                                                                                                                                                                                                             | `params.ts`                                                           |
| 数値検証                        | `sendOrder` は安全な整数、datagram の max buffered は unsigned long の上限までに制限した                                                                                                                                                                                                                                              | `params.ts`                                                           |
| close reason の切り詰め         | UTF-8 で 1024 byte を超える場合に code point 境界で切り詰め、UI に切り詰めの注記を出す                                                                                                                                                                                                                                                | `params.ts`、`signals.ts`、`components/PostConnectionPanel.tsx`       |
| BCD テーブル                    | `protocols` を追加し、Safari の max buffered を `preview`、experimental を 4 項目に反映した。確認日を 2026-10-31 に更新し、バッジに preview / experimental を追加した                                                                                                                                                                 | `bcd.ts`、`components/BcdBadges.tsx`                                  |
| デッドデータの解消              | `sendOrder` のバッジをストリーム作成パネルに追加した                                                                                                                                                                                                                                                                                  | `components/BidiStreamPanel.tsx`、`components/UniSendStreamPanel.tsx` |
| 接続設定の復帰                  | error 状態でも入力検証の結果を直せるように、設定の無効化を connecting / connected の間だけにした                                                                                                                                                                                                                                      | `signals.ts`、`components/ConnectionPanel.tsx`                        |
| セッション世代                  | 接続ごとに世代を進め、旧セッションの ready / closed / draining ハンドラが新しいセッションの状態を書き換えないようにした。ready 解決直後に closed が確定した場合に connected と表示しないガードも追加した                                                                                                                              | `signals.ts`                                                          |
| 接続中の状態表示                | connecting 中の状態表示が Disconnected になっていたのを Connecting... にした                                                                                                                                                                                                                                                          | `components/ConnectionPanel.tsx`                                      |
| 静的パネルの詳細項目            | サマリで数えない詳細項目 (createWritable) を中立色にし、「not counted in summary」を表示した。deprecated と詳細項目を分母から除く旨を注記した                                                                                                                                                                                         | `components/StaticApiSupportPanel.tsx`                                |
| BCD バッジの型                  | バッジ名を `BcdSupportName` で型付けし、タイポをビルド時に検出できるようにした。notes と section を tooltip に表示した                                                                                                                                                                                                                | `bcd.ts`、`components/BcdBadges.tsx`                                  |
| 境界テスト                      | 2 byte 文字の 1024 byte 境界、Base64 の空白 / パディングなし / URL-safe、protocols の引用符 / 空白 / カンマの扱いを追加した                                                                                                                                                                                                           | `params.test.ts`                                                      |

| README | 静的チェックが存在確認であること、HTTP バージョンが N/A になり得ることを反映した | `README.md` |

### D.2 検証結果 (接続なしで実施)

- `vp test run`: 256 files / 4331 tests がすべて成功。追加した単体テストは `staticApiSupport.test.ts` (8)、`bcd.test.ts` (6)、`params.test.ts` の追加分 (28)、`src/httpVersion.test.ts` の更新 (5) である
- `vp exec playwright test --project=chromium tests/e2e/webtransport-devtools.spec.ts`: 11 tests がすべて成功。静的パネルの表示と present / absent、分母 50、`protocols` のバッジ、preview / experimental バッジ、接続失敗時の `Error` 表示と closed outcome、protocols の非 ASCII 拒否と復帰、証明書ハッシュの 32 byte 拒否、前回 closed outcome のクリアを実際のブラウザで確認した
- 実ブラウザでの突き合わせ (Playwright 同梱の Chromium 156 / Firefox 157 / WebKit 27.2): 各ブラウザの実際の API 有無とパネルの present / absent が一致し、分母が 50 であること、接続失敗後に設定を編集して再試行できること、再試行が接続エラーになることを確認した
  - Chromium 156: `Partially Present (25 / 50)`
  - Firefox 157: `Partially Present (40 / 50)`
  - WebKit 27.2: `All Present (50 / 50)`
  - 3 ブラウザとも、検証エラー後に protocols 入力が編集可能で、値を直して再試行すると接続エラー (`Error`) と closed outcome (rejected) が表示された
- `vp check` (format / lint / type)、`vp run build:devtools`: すべて成功
- 独立レビューを実施し、重大 2 件 (error 状態で設定が無効化され復帰できない、旧セッションの closed ハンドラが新セッションを reset する競合) を修正した。セッション競合は接続が必要なため E2E では再現できず、世代ガードの実装とレビューでの確認に留めている
- 接続先の WebTransport サーバーは無いため、接続成功後の表示 (統計値、ストリーミング、writer、BYOB、datagram の上限超過) は未検証である

### D.3 未対応 (P2)

- `getStats()` の呼び出しと統計の表示
- `incomingBidirectionalStreams` の受信と表示
- `createSendGroup()` と `sendGroup` / `sendOrder` の設定・取得
- `WebTransportWriter` の `atomicWrite()` / `commit()`
- `exportKeyingMaterial()` の呼び出し
- ストリームの abort / cancel と `WebTransportError.source` / `streamErrorCode` の表示
- `close()` (state が `connecting` のとき) のサポート
- BYOB リーダーと `datagramsReadableType: "bytes"` の効果判定
- `maxDatagramSize` の表示と超過する datagram の警告
- 辞書メンバーが無視されていないかの判定
