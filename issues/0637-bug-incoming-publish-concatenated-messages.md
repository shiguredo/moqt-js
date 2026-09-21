# 受信 PUBLISH で同一 chunk の 2 通目以降のメッセージを破棄する

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-incoming-publish-concatenated-messages
- Polished: {YYYY-MM-DD}

## 目的

QUIC のストリームに書き込み境界は無いため、ピアは PUBLISH と PUBLISH_DONE を同じ chunk に連結して送れる。受信側が 2 通目以降を取りこぼすと購読が終わらず、アプリに end が届かない。

## 現状

- `src/session/incomingPublish.ts` の `incomingPublishReadFirstBidiMessage` は `messages[0]` だけを返し、残りを捨てる。関数の JSDoc にも「同一チャンクに連結された先頭以降のメッセージは破棄される」と明記されている
- 後続メッセージ用の `ControlStreamReader` は `incomingPublishHandleBidirectionalStream` の中で `subControlReader` として新しく作られる。`ControlStreamReader` は取り出したメッセージをバッファから削除するため、先読み済みのバイトは復元できない
- そのため同一 chunk に連結された PUBLISH_DONE は誰も処理しない。読み取りループは終端の FIN で `bidi.FIN_WITHOUT_PUBLISH_DONE_MESSAGE` を購読へ通知するため、アプリには end ではなく error が届く
- 要求側の同種の問題は `bidiDispatchResponse` が `context.remainingMessages` に残りを保持し、読み取りループの初期メッセージとして渡す形で closed/0623 により修正済みである。応答側の受信 PUBLISH 経路だけが非対称のまま残っている

## 設計方針

- `incomingPublishReadFirstBidiMessage` を「先頭メッセージと残りメッセージ」を返す形にする
- `incomingPublishHandleBidirectionalStream` が作る `subControlReader` に残りメッセージを引き継ぎ、`incomingPublishRunStreamSubLoop` の処理対象に含める。`bidiDispatchResponse` の `context.remainingMessages` と同じ扱いに揃える
- `src/session.test.ts` の `createIncomingPublishStream` は追加フレームを別 chunk で enqueue するため、PUBLISH と PUBLISH_DONE を同一 chunk に連結したストリームを作るテストを追加する

## 完了条件

- 同一 chunk に連結された PUBLISH_DONE が処理され、アプリに end が通知される
- 連結が無い場合の既存挙動 (FIN で `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` を通知する) が維持される
- 追加したテストと既存テストが通る

## 参照

- draft-ietf-moq-transport-21 §6.4.2.2 (必要なメッセージが揃う前に FIN を受けた場合、その request は失敗として扱う)
- draft-ietf-moq-transport-21 §9.9 (PUBLISH_DONE)

## 解決方法

{未着手}
