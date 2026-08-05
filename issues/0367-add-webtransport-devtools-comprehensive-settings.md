# webtransport-devtools で WebTransport の設定を徹底的に設定可能にする

- Created: 2026-08-05
- Completed: 2026-08-05
- Branch: feature/add-webtransport-devtools-settings
- Polished: 2026-08-05

## 目的

webtransport-devtools は WebTransport セッションの動作確認用ツールだが、現在は接続先 URL と自己署名証明書のハッシュしか設定できない。W3C WebTransport（Candidate Recommendation、2026-07-30 版）には接続確立前・確立後・ストリーム作成時に設定できる項目が多数定義されており、これらを UI から設定できるようにして devtools としての実用性を高める。

## 現状

- ConnectionPanel で `url` と `certificateHash` のみ設定可能
- `devtools/src/webtransport-devtools/signals.ts` の `connect()` は `WebTransportOptions` に `serverCertificateHashes` しか渡していない
- datagram の `incomingMaxAge` / `outgoingMaxAge` などの接続後の属性変更に未対応
- `createUnidirectionalStream()` / `createBidirectionalStream()` に `sendOrder` などのオプションを渡していない
- 切断時に `closeCode` / `reason` を指定できない

## 設計方針

W3C WebTransport CR の辞書定義に従い、設定を 4 系統に分けて UI 化する。各設定項目の仕様根拠（W3C 節番号）は項目ラベル横に注記として表示する。

### 1. 接続時設定 (ConnectionPanel、コンストラクタオプション WebTransportOptions §6.9)

- `allowPooling` (boolean、§6.9)
- `requireUnreliable` (boolean、§6.9)
- `congestionControl` ("default" / "throughput" / "low-latency"、§6.9)
- `headers` (HeadersInit、key: value 形式の複数行入力、§6.9)
- `protocols` (カンマ区切り文字列、§6.9)
- `datagramsReadableType` ("bytes"、§6.9。enum 値は "bytes" のみであり "default" は enum 値ではない。省略時は既定の readable stream になる)
- `anticipatedConcurrentIncomingUnidirectionalStreams` / `anticipatedConcurrentIncomingBidirectionalStreams` (数値、§6.9)
- `serverCertificateHashes` (既存の Certificate Hash 入力を維持、§6.9)

ブラウザ未対応の判定は MDN Browser Compat Data ベースの静的テーブルで行い、本 issue で追加する全設定項目（§1〜§3）に適用する。BCD で対応状況が判別できる項目のみ注記し、BCD にエントリの無い項目（`headers` / `protocols` / `datagramsReadableType` / `waitUntilAvailable` など）は注記しない。非対応範囲は BCD の実値に従う（例: `sendOrder` は Chrome 未対応 / Firefox 119+ / Safari 26.4+、`anticipatedConcurrentIncoming*Streams` は Chrome・Firefox 未対応 / Safari 26.4+）。静的テーブルには出典と確認日を注記する。既存の StaticApiSupportPanel（`detectStaticApiSupport()`）はプロトタイプレベル検出のまま維持し、本節の注記と役割を分ける。

`allowPooling` と `serverCertificateHashes` は仕様上同時指定できない（どちらか一方を有効化したら他方を無効化する）。`headers` は Fetch の forbidden request-header 制約と `wt-available-protocols` ヘッダーの禁止（TypeError）に抵触する入力を入力段階で拒否する。`protocols` は重複・空要素・512 文字超過の入力を受け付けない（仕様の SyntaxError を防ぐ）。

`datagramsReadableType` に "bytes" を指定した場合、受信ストリームは byte stream になり、データグラムのメッセージ境界が保証されない（W3C §6.9 注記）。"bytes" 指定時の受信は、現行の `receiveDatagrams()`（デフォルトリーダーで引数なしの `read()` を呼ぶ）が byte stream から読み取れるかを実機確認し、読み取れない場合は BYOB リーダー対応にする。

### 2. 接続後設定

接続中のみ編集可能なパネルを新設し、「適用」ボタンで反映する。入力値は仕様の setter 制約に従い、切断時にリセットする。

- `wt.datagrams` の `incomingMaxAge` / `outgoingMaxAge` / `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams` (W3C §5.3)
  - `incomingMaxAge` / `outgoingMaxAge`: ミリ秒。負値・NaN は拒否し、0 は null（実装定義のデフォルト期限を適用）扱い
  - `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`: 1 未満は 1 にクランプ
- `close()` に `closeCode` / `reason` を指定可能にする (W3C §6.10)。ユーザー操作の Disconnect 時にのみ渡し、サーバー起因の切断では渡さない。`closeCode` / `reason` は接続中も編集できるようにする（ConnectionPanel の入力は `settingsDisabled` で接続中に無効化されるため、接続後設定パネルに配置する）

既存の StaticApiSupportPanel の Datagrams グループは旧属性名（`incomingHighWaterMark` / `outgoingHighWaterMark`）のまま残っているため、新しい属性名（`incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams`）に更新する。

### 3. ストリーム作成時設定

- `createUnidirectionalStream()` / `createBidirectionalStream()` に `sendOrder` (§6.11) / `waitUntilAvailable` (§6.12) を渡せるようにする
- ストリーム作成時に `sendOrder` を指定できる入力欄と、`waitUntilAvailable` を指定できるチェックボックスを各パネルの New Stream ボタン付近に設ける。作成後の属性編集（WebTransportSendStream.sendOrder）は本 issue の対象外とする
- `sendGroup`（§6.11）と datagram 送信の `createWritable({ sendOrder })`（§5.2）は本 issue の対象外とする

### 4. クエリパラメータ連携

- クエリ連携の対象は「接続時設定」のみとする。接続後設定はページロード時点で未接続のため URL に載せない
- `buildQueryString()` の拡張に加え、読み込み側の `getInitialParams()` も拡張して URL から復元する
- デフォルト値の項目はクエリパラメータに含めない（既存の `certificateHash` 省略パターンに合わせる）
- `headers` は 1 行 1 ヘッダーの key: value をエンコードしてクエリに載せる
- 排他の組み合わせ（`allowPooling` と `certificateHash`）が URL に共存する場合は、接続時設定 UI の排他検証で弾く

## 完了条件

- 上記 1〜4 の設定項目が UI から変更でき、`connect()` / ストリーム作成 / datagram 設定 / `close()` の実動作に反映されること（未対応ブラウザでは「値が API に渡されること」までを確認し、挙動変化は検証対象外とする）
- 注記対象項目（BCD で判別可能な項目）について、ブラウザ未対応が UI 上で判別できること
- 接続時設定がクエリパラメータとして URL 共有でき、URL から復元できること
- 各設定項目の仕様根拠（W3C 節番号）が UI 上で確認できること
- 既存の StaticApiSupportPanel の Datagrams グループが新しい属性名に更新されていること
- `vp run build:devtools` が成功すること
- CHANGES.md の `## develop` に [ADD] エントリが追加されていること

## 解決方法

- `params.ts` を新設し、接続時設定の入力検証（headers の forbidden request-header / wt-available-protocols 拒否、protocols の重複・空要素・512 文字超過拒否、anticipated streams の unsigned short 検証、allowPooling と certificateHash の排他検証）とクエリパラメータのビルド / パースを純粋関数として実装した
- `bcd.ts` を新設し、MDN Browser Compat Data に基づく静的テーブル（確認日 2026-08-05）を追加した
- `signals.ts` を拡張し、接続時設定の signal 群、接続後設定（datagrams 属性と closeCode / reason）、ストリーム作成時設定（sendOrder / waitUntilAvailable）を追加した
- `ConnectionPanel` に W3C §6.9 の全接続時設定 UI を追加し、各項目に仕様節番号と BCD 対応バッジを表示した
- `PostConnectionPanel` を新設し、W3C §5.3 の datagrams 属性（適用ボタン付き）と §6.10 の closeCode / reason を提供した
- `BidiStreamPanel` / `UniSendStreamPanel` に sendOrder / waitUntilAvailable の入力欄を追加した
- `StaticApiSupportPanel` の Datagrams グループを incomingMaxBufferedDatagrams / outgoingMaxBufferedDatagrams に更新した
- `buildQueryString` / `getInitialParams` を拡張し、接続時設定の URL 共有・復元に対応した
- `params.test.ts` に 44 件の単体テストを追加した
- `tests/e2e/webtransport-devtools.spec.ts` に Playwright E2E テスト 3 件を追加し、主要 UI 要素に data-testid を付与した
- `playwright.config.ts` に devtools の webServer を追加した
