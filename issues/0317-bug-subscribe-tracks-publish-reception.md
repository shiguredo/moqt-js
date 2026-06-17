# SUBSCRIBE_TRACKS に対する PUBLISH メッセージ受信を実装する

- Priority: High
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-subscribe-tracks-publish-reception

## 目的

`Session.subscribeTracks()` を呼び出しても、サーバーから新規双方向ストリームで到着する `PUBLISH` メッセージを受信できない問題を修正する。`incomingBidirectionalStreams` の監視ループが未実装のため、`SUBSCRIBE_TRACKS` リクエストに対する `PUBLISH` 応答がアプリケーションに届かない。

## 優先度根拠

`SUBSCRIBE_TRACKS` は複数 track をまとめて subscribe する MOQT 制御メッセージであり、対応する `PUBLISH` メッセージを受信できなければ subscriber 側は一切のデータを受け取れない。`subscribeTracks()` の呼び出し自体は成功するが、その後の双方向ストリームが無限に待たされるため、機能が完全に失われる。High とする。

## 現状

`src/session.ts` において:

- `startTracksStreamLoop` がコメント等で準備されているが、`incomingBidirectionalStreams` を監視する実体がない。
- `startIncomingStreamLoop` 等の既存 incoming ストリーム処理は単方向データストリームや datagram を対象としており、双方向ストリーム上の `PUBLISH` メッセージ受信をカバーしていない。
- `SUBSCRIBE_TRACKS` を送信しても、返ってくる `PUBLISH` メッセージを読み取る経路が存在しない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.19 (SUBSCRIBE_TRACKS)**: subscriber が複数の track をまとめて subscribe するメッセージ。成功時、サーバーは新規双方向ストリームを開き `PUBLISH` メッセージを返す。
- **§6 (Version and ALPN negotiation 等、双方向ストリームの使い方)**: 双方向ストリームは request/response 系メッセージの受信に使われる。

## 設計方針

`incomingBidirectionalStreams` を `startTracksStreamLoop` (または既存の incoming stream ループに統合) で読み取り、到着した `PUBLISH` メッセージを適切な subscriber/consumer へ配送する。

候補:

1. `startTracksStreamLoop` を独立ループとして実装し、`incomingBidirectionalStreams` の各ストリームを読み取って `PUBLISH` をハンドリングする。
2. 既存の `startIncomingStreamLoop` を双方向ストリームにも対応させ、ストリーム種別に応じて `PUBLISH` / データストリーム / datagram を振り分ける。

いずれの案でも、以下を守ること。

- `PUBLISH` メッセージは双方向ストリーム上の最初のメッセージとして到着する想定でデコードする。
- `PUBLISH` に対応する `subscribeTracks()` 呼び出し時の状態 (`pendingTracksSubscriptions` 等) を正しく解決し、resolver または callback を呼び出す。
- 既存の `bidi.ts` で実装されている request/response パターン (`bidiReadRequestStreamMessages` 等) を流用する場合は、メッセージ種別の振り分けと重複処理を防ぐ。
- エラー時は `closeWithError` 等を用いてセッションを適切に終了する。

## 完了条件

- `Session.subscribeTracks()` 呼び出し後、サーバーから到着する `PUBLISH` メッセージを受信できる
- 受信した `PUBLISH` メッセージから track 情報がアプリケーションまたは対応する subscriber に正しく渡る
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリを追記する
