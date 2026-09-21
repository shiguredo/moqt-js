# 受信 PUBLISH で同一 chunk の 2 通目以降のメッセージを破棄する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-concatenated-messages
- Polished: 2026-09-21

## 目的

QUIC のストリームに書き込み境界は無いため、ピアは PUBLISH と PUBLISH_DONE を同じ chunk に連結して送れる。受信側が 2 通目以降を取りこぼすと PUBLISH_DONE を処理できないままになり、購読は正常終了できず、FIN を受けた時点でアプリに end ではなく error が届く。

## 現状

- `src/session/incomingPublish.ts` の `incomingPublishReadFirstBidiMessage` は `messages[0]` だけを返し、残りを捨てる。関数の JSDoc にも「同一チャンクに連結された先頭以降のメッセージは破棄される」と明記されている
- 後続メッセージ用の `ControlStreamReader` は `incomingPublishHandleBidirectionalStream` の中で `subControlReader` として新しく作られる。`ControlStreamReader` は取り出したメッセージをバッファから削除するため、先読み済みのバイトは復元できない
- そのため同一 chunk に連結された PUBLISH_DONE は誰も処理しない。読み取りループは終端の FIN で `bidi.FIN_WITHOUT_PUBLISH_DONE_MESSAGE` を購読へ通知するため、アプリには end ではなく error が届く
- 要求側の同種の問題は `bidiDispatchResponse` が `context.remainingMessages` に残りを保持し、読み取りループの初期メッセージとして渡す形で closed/0623 により修正済みである。応答側の受信 PUBLISH 経路だけが非対称のまま残っている

## 設計方針

- `incomingPublishReadFirstBidiMessage` を「先頭メッセージと残りメッセージ」を返す形にする
- 先頭読み取りとサブループで同じ `ControlStreamReader` を使う。`incomingPublishHandleBidirectionalStream` で `subControlReader` を作って `incomingPublishReadFirstBidiMessage` に渡し、最初の read で生じた半端なバイトも同じ reader に残したままサブループへ引き継ぐ (reader を作り直すと半端なバイトは復元できない)
- 残りメッセージは `incomingPublishRunStreamSubLoop` に `ControlMessage[]` の引数として渡し、最初の `subReader.read()` より前に処理する。要求側 (`bidiDispatchResponse` が `context.remainingMessages` に保持し、`bidiReadRequestStreamMessages` が `initialMessages` として最初の read より前に処理する形) と同じ扱いに揃える (順序を逆にすると、PUBLISH_DONE の直後に届いた FIN が先に `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` の分岐へ入る)
- `src/session.test.ts` の `createIncomingPublishStream` は PUBLISH を単独 chunk として固定で enqueue するため、追加フレームを先頭 chunk に連結するオプション (または chunk 配列を渡す引数) を足し、PUBLISH と PUBLISH_DONE を連結した 1 chunk を渡すテストを追加する
- 半端なバイトが残るケースもテストする。chunk 境界がメッセージの途中に落ちる分割を渡しても、後続メッセージを取りこぼさないことを固定する

## 完了条件

- 同一 chunk に連結された PUBLISH_DONE が処理され、アプリに end が通知される
- 連結が無い場合の既存挙動 (FIN で `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` を通知する) が維持される
- chunk 境界がメッセージの途中に落ちる分割でも、後続メッセージが取りこぼされない
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §6.4.2.2 (必要なメッセージが揃う前に FIN を受けた場合、その request は失敗として扱う)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)
- issues/0644 (同じ `createIncomingPublishStream` を変更するため、同時に実装するとテストヘルパーの変更が競合する)

## 解決方法

{未着手}
