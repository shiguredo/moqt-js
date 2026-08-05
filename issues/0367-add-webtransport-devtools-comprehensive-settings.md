# webtransport-devtools で WebTransport の設定を徹底的に設定可能にする

- Created: 2026-08-05
- Completed: {YYYY-MM-DD}
- Branch: feature/add-webtransport-devtools-settings
- Polished: {YYYY-MM-DD}

## 目的

webtransport-devtools は WebTransport セッションの動作確認用ツールだが、現在は接続先 URL と自己署名証明書のハッシュしか設定できない。W3C WebTransport (Candidate Recommendation) には接続確立前・確立後・ストリーム作成時に設定できる項目が多数定義されており、これらを UI から設定できるようにして devtools としての実用性を高める。

## 現状

- ConnectionPanel で `url` と `certificateHash` のみ設定可能
- `devtools/src/webtransport-devtools/signals.ts` の `connect()` は `WebTransportOptions` に `serverCertificateHashes` しか渡していない
- datagram の `incomingMaxAge` / `outgoingMaxAge` などの接続後の属性変更に未対応
- `createUnidirectionalStream()` / `createBidirectionalStream()` に `sendOrder` などのオプションを渡していない
- 切断時に `closeCode` / `reason` を指定できない

## 設計方針

W3C WebTransport CR の辞書定義に従い、設定を 4 系統に分けて UI 化する。

### 1. 接続時設定 (ConnectionPanel、コンストラクタオプション WebTransportOptions §6.9)

- `allowPooling` (boolean)
- `requireUnreliable` (boolean)
- `congestionControl` ("default" / "throughput" / "low-latency")
- `headers` (HeadersInit、key: value 形式の複数行入力)
- `protocols` (カンマ区切り文字列)
- `datagramsReadableType` ("bytes")
- `anticipatedConcurrentIncomingUnidirectionalStreams` / `anticipatedConcurrentIncomingBidirectionalStreams` (数値)
- 既存の `serverCertificateHashes`

ブラウザ未対応の項目 (例: Chrome で `allowPooling` / `congestionControl` / `requireUnreliable` は未実装) は、各項目に MDN Browser Compat Data を根拠とした対応状況を注記するか、非対応ブラウザでは無効化する。判定方法は実装時に確認する。

### 2. 接続後設定

- `wt.datagrams` の `incomingMaxAge` / `outgoingMaxAge` / `incomingMaxBufferedDatagrams` / `outgoingMaxBufferedDatagrams` を UI から設定 (W3C §5.3)
- `close()` に `closeCode` / `reason` を指定可能にする (W3C §6.10)

### 3. ストリーム作成時設定

- `createUnidirectionalStream()` / `createBidirectionalStream()` に `sendOrder` / `waitUntilAvailable` を渡せるようにする (W3C §6.12)
- ストリームごとに `sendOrder` を設定できる UI

### 4. クエリパラメータ連携

- 新しい設定項目を `buildQueryString()` に反映し、URL 共有できるようにする
- 設定項目が増えるため、URL が長大化しないようデフォルト値は省略する運用を検討する

## 完了条件

- 上記 1〜4 の設定項目が UI から変更でき、`connect()` / ストリーム作成 / datagram 設定 / `close()` の実動作に反映されること
- ブラウザ未対応の項目が UI 上で判別できること
- 設定内容がクエリパラメータとして URL 共有できること
- 各設定項目の仕様根拠 (W3C 節番号) が UI 上で確認できること
