# wt-devtools に WebTransport API の静的対応状況チェックを追加する

Created: 2026-04-22
Model: Opus 4.7

## 概要

wt-devtools (devtools の WebTransport DevTools) に、接続前に実行できる静的な WebTransport API 対応状況チェックを追加する。Connection Settings の上に専用パネルを配置し、ブラウザがこの DevTools の使用する WebTransport 機能群を実装しているかをページロード時に一度だけ判定して可視化する。

## 根拠

### 静的チェックは接続チェックと別物

既存の `devtools/src/webtransport-devtools/signals.ts:249-262` で構築している `wtApiSupport` ツリー (ConnectionPanel 下部に表示) は、**接続後**に `WebTransport` インスタンスから値を読み取る「接続チェック」である。これはセッションが実際に確立した状態でアクセサが生きているか、ネゴシエート値 (reliability / protocol / draining 等) がどうなっているかを確認するためにあり、削除・変更しない。

今回追加するのは**接続前の静的チェック**で、責務も評価対象も異なる。

| 観点           | 静的チェック (新規)                                    | 接続チェック (既存)                        |
| -------------- | ------------------------------------------------------ | ------------------------------------------ |
| 評価タイミング | ページロード時に 1 回                                  | `await wt.ready` 後                        |
| 評価対象       | `WebTransport.prototype` 等のグローバル / プロトタイプ | `wt` インスタンス                          |
| 依存           | ブラウザ実装のみ                                       | ブラウザ + サーバー + ネゴシエーション結果 |
| 目的           | 「このブラウザで動くか」の事前判定                     | 「このセッションで何が効いているか」の確認 |

両方を併置することで、接続失敗時に「ブラウザ未対応」「証明書ハッシュ不一致」「サーバー側問題」「ネゴシエーション結果」を切り分けやすくなる。

### DevTools の役割との整合

wt-devtools は WebTransport API の各機能 (bidi / uni / datagram / getStats / draining / reliability / congestionControl) を一通り操作できることを狙ったツールである。そのため、チェック対象を「WebTransport 仕様の全 IDL」ではなく「この DevTools が実際に触る API 群」に絞ると、「この DevTools の全機能がこのブラウザで使えるか」を一目で確認できる。

### Safari 26.x 以降と Chrome の仕様差

`WebTransportDatagramDuplexStream.createWritable()` (最新仕様) と `writable` プロパティ (旧仕様) のように、同じ機能に対してブラウザごとに実装が分かれているものがある (`signals.ts:666-678` の分岐が実例)。静的チェックで両方の有無を示すことで、sendDatagram が挙動しない場合の原因切り分けが容易になる。

## 該当箇所

- `devtools/src/webtransport-devtools/signals.ts`
  - 静的チェック結果を保持するシグナル (仮称 `wtStaticApiSupport`) を新設する
  - 既存の `wtApiSupport` (接続チェック) は変更しない
- `devtools/src/webtransport-devtools/components/` に新規コンポーネントを追加
  - 仮称 `StaticApiSupportPanel.tsx`
- `devtools/src/webtransport-devtools/App.tsx`
  - `ConnectionPanel` の上に `StaticApiSupportPanel` を配置する
- `devtools/src/webtransport-devtools/components/ConnectionPanel.tsx`
  - 変更なし (既存の接続チェック表示はそのまま)

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

### 既存「接続チェック (API Support)」表示の扱い

既存の接続チェック (`ConnectionPanel.tsx:211-216` の `wtApiSupport` ツリー) は**変更しない**。静的チェックとは責務が異なるため併置する。

## 検証

- `vp run build:devtools` が通ること
- `vp run build` が通ること (ワークスペース全体)
- `vitest run` で既存テストが通ること (静的チェック対象のロジックに純粋関数部分があればテストを追加する)
- Chrome (WebTransport 対応) で、接続前にサマリが「全て対応」を示すこと
- Firefox など WebTransport 未実装環境で「未対応」表示になること (手元で確認できる範囲で確認)
- Safari (26.x 以降で createWritable がある環境) と Chrome (writable プロパティの旧仕様) でサマリに差異が出ないが、詳細表示では `createWritable` と `writable` の対応状況が別々に見えること
