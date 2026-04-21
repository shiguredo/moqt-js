# wt-devtools に WebTransport API の静的対応状況チェックを追加する

Created: 2026-04-22
Model: Opus 4.7

## 概要

wt-devtools (devtools の WebTransport DevTools) に、接続前に実行できる静的な WebTransport API 対応状況チェックを追加する。Connection Settings の上に専用パネルを配置し、ブラウザがこの DevTools の使用する WebTransport 機能群を実装しているかをページロード時に一度だけ判定して可視化する。

## 根拠

### 既存の「API Support」表示との責務分離

現状 `devtools/src/webtransport-devtools/signals.ts:249-262` で構築している `wtApiSupport` ツリー (ConnectionPanel 下部に表示) は、**接続後**に `WebTransport` インスタンスから値を読み取っている。このツリーには 2 種類の情報が混在している。

- 静的な API 存在確認 (例: `createBidirectionalStream` が関数か)
- セッションごとにネゴシエートされる実値 (例: `reliability`、`protocol`、`responseHeaders`、`congestionControl`、`draining`)

静的な API 存在確認はブラウザ実装に依存するだけで、接続の成否やサーバー側の動作と独立している。サーバーへ接続する前に「そもそもこのブラウザで動くのか」を確認できれば、証明書ハッシュの不一致やサーバー側の問題と、ブラウザ側の API 未実装とを切り分けやすくなる。

### DevTools の役割との整合

wt-devtools は WebTransport API の各機能 (bidi / uni / datagram / getStats / draining / reliability / congestionControl) を一通り操作できることを狙ったツールである。そのため、チェック対象を「WebTransport 仕様の全 IDL」ではなく「この DevTools が実際に触る API 群」に絞ると、「この DevTools の全機能がこのブラウザで使えるか」を一目で確認できる。

### Safari 26.x 以降と Chrome の仕様差

`WebTransportDatagramDuplexStream.createWritable()` (最新仕様) と `writable` プロパティ (旧仕様) のように、同じ機能に対してブラウザごとに実装が分かれているものがある (`signals.ts:666-678` の分岐が実例)。静的チェックで両方の有無を示すことで、sendDatagram が挙動しない場合の原因切り分けが容易になる。

## 該当箇所

- `devtools/src/webtransport-devtools/signals.ts`
  - `wtApiSupport` を接続前の静的チェック専用に再定義するか、別シグナルを追加する
  - 接続後パネルに残す項目 (reliability / congestionControl / protocol / responseHeaders / draining Promise 状態) は現状どおり残す
- `devtools/src/webtransport-devtools/components/ConnectionPanel.tsx`
  - 接続後ブロックから API 存在チェック相当の表示 (`createBidirectionalStream` / `createUnidirectionalStream` / `incomingBidirectionalStreams` / `incomingUnidirectionalStreams` / `datagrams` / `closed` / `ready` / `getStats` など) を除去する
- `devtools/src/webtransport-devtools/components/` に新規コンポーネントを追加
  - 仮称 `ApiSupportPanel.tsx`
- `devtools/src/webtransport-devtools/App.tsx`
  - `ConnectionPanel` の上に `ApiSupportPanel` を配置する

## 修正方針

### チェック対象 (静的)

以下をページロード時に 1 回評価する。いずれも接続不要で判定できる。

- グローバル
  - `"WebTransport" in self`
  - `"WebTransportError" in self`
  - `"WebTransportBidirectionalStream" in self`
  - `"WebTransportReceiveStream" in self`
  - `"WebTransportSendStream" in self`
  - `"WebTransportDatagramDuplexStream" in self`
- `WebTransport.prototype` のメンバー存在確認
  - `createBidirectionalStream`
  - `createUnidirectionalStream`
  - `incomingBidirectionalStreams`
  - `incomingUnidirectionalStreams`
  - `datagrams`
  - `ready`
  - `closed`
  - `draining`
  - `reliability`
  - `congestionControl`
  - `supportsReliableOnly`
  - `protocol`
  - `responseHeaders`
  - `getStats`
  - `close`
- `WebTransportDatagramDuplexStream.prototype` のメンバー存在確認
  - `readable`
  - `writable` (旧仕様)
  - `createWritable` (最新仕様)
  - `maxDatagramSize`
  - `incomingMaxAge` / `outgoingMaxAge` / `incomingHighWaterMark` / `outgoingHighWaterMark`

### 表示形式

- パネル名は仮称「WebTransport API Support」
- サマリバッジを常時表示し、詳細は折りたたみ (デフォルト折りたたみ)
  - サマリは「全て対応」「一部未対応 (N 項目)」「WebTransport 未対応」の 3 状態
- 詳細部は機能カテゴリごとにグループ化 (Core / Streams / Datagrams / Stats / Session Info)
- 各項目は「API 名」と「対応状況」の 2 列 (対応/未対応はテキストまたは ASCII 記号で表現。絵文字は CLAUDE.md の方針により利用しない)
- 既存の `apiSupportValueClass` の配色ルールを踏襲し、未対応は赤、対応は緑

### 既存「API Support」表示の扱い

接続後パネル (`ConnectionPanel.tsx:211-216`) の `wtApiSupport` ツリー表示は削除する。代わりに接続後パネルは以下のランタイム値のみを表示する (既に個別表示している `wtReliability` / `wtCongestionControl` / `wtSupportsReliableOnly` / `wtProtocol` / `wtResponseHeaders` / `wtDrainingState` は現状維持)。

`signals.ts` の `wtApiSupport` シグナルと関連する構築ロジックは削除するか、静的チェック用に再利用する。

## 検証

- `vp run build:devtools` が通ること
- `vp run build` が通ること (ワークスペース全体)
- `vitest run` で既存テストが通ること (静的チェック対象のロジックに純粋関数部分があればテストを追加する)
- Chrome (WebTransport 対応) で、接続前にサマリが「全て対応」を示すこと
- Firefox など WebTransport 未実装環境で「未対応」表示になること (手元で確認できる範囲で確認)
- Safari (26.x 以降で createWritable がある環境) と Chrome (writable プロパティの旧仕様) でサマリに差異が出ないが、詳細表示では `createWritable` と `writable` の対応状況が別々に見えること
