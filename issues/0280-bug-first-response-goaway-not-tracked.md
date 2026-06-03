# 初回応答 GOAWAY が goawayReceivedOnRequestStreams に追加されない

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

`bidiReadPublishResponse` 等の初回応答 GOAWAY 分岐では `goawayReceivedOnRequestStreams.add(requestId)` が行われておらず、その後の後続メッセージループ (`bidiReadRequestStreamMessages`) が起動された場合に重複 GOAWAY 検出が機能しないバグを修正する。

## 優先度根拠

重複 GOAWAY 検出の抜け穴。攻撃やプロトコル違反の検出漏れにつながる。

## 現状

- `src/session/bidi.ts:307` (`bidiReadPublishResponse`): GOAWAY 受信時に `add` なし
- `src/session/bidi.ts:406` (`bidiReadSubscribeResponse`): GOAWAY 受信時に `add` なし
- `src/session/bidi.ts:503` (`bidiReadFetchResponse`): GOAWAY 受信時に `add` なし
- `src/session/bidi.ts:560` (`bidiReadTrackStatusResponse`): GOAWAY 受信時に `add` なし

一方 `src/session/bidi.ts:660` (`bidiReadRequestStreamMessages`) では `goawayReceivedOnRequestStreams.add(requestId)` が正しく行われている。

draft-ietf-moq-transport-18 §10.4: 同一リクエストストリーム上の重複 GOAWAY は PROTOCOL_VIOLATION。

## 設計方針

- 全 4 箇所の初回応答 GOAWAY 分岐に `session.goawayReceivedOnRequestStreams.add(requestId)` を追加する
- または初回応答では `bidiReadRequestStreamMessages` が起動されない前提なら、その意図をコメントで明示する

## 完了条件

- 全 GOAWAY 受信箇所で `goawayReceivedOnRequestStreams` に一貫して追加される
- テストが追加されている
