# 受信 PUBLISH で同一 chunk の 2 通目以降のメッセージを破棄する

- Created: 2026-09-21
- Completed: 2026-09-24
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

- `src/session/incomingPublish.ts` の `incomingPublishReadFirstBidiMessage` を、先頭メッセージと同一チャンクに連結されていた残りメッセージ (`remainingMessages`) を返す形にした。戻り値の型は `IncomingPublishFirstBidiMessage`
- 先頭読み取りに使う `ControlStreamReader` を `incomingPublishHandleBidirectionalStream` で生成して関数へ渡し、そのままサブループへ引き継ぐようにした。reader を作り直すと、最初の read で生じた半端なバイト (メッセージの途中でチャンクが切れた分) を復元できない
- `incomingPublishRunStreamSubLoop` に `initialMessages` 引数を足し、1 チャンク分のメッセージ処理を入れ子関数 `processMessages` に切り出して、最初の `subReader.read()` より前に連結分を処理するようにした。順序を逆にすると、連結された PUBLISH_DONE の直後に届いた FIN が先に `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` の分岐へ入る。購読が active の間だけ処理する点はループ本体と同じ
- 要求側 (`bidiDispatchResponse` が `context.remainingMessages` を保持し `bidiReadRequestStreamMessages` が `initialMessages` として処理する形) と同じ扱いに揃えた
- `src/session.test.ts` の `createIncomingPublishStream` に `frameChunking` (separate / coalesce / coalesce-first / coalesce-half) と `TRACK_ENDED` の PUBLISH_DONE フレーム生成ヘルパーを足し、次の 6 テストを追加した
  - 連結された PUBLISH_DONE が処理され end が通知される
  - 連結された PUBLISH_DONE がメッセージ途中で分割されても処理される (reader 共有の固定)
  - 連結された REQUEST_UPDATE と PUBLISH_DONE が順に処理される (REQUEST_OK が 2 通書かれる)
  - 連結された複数の REQUEST_UPDATE も上限判定に数える
  - 連結チャンクを跨いでも REQUEST_UPDATE の未応答数が持ち越されない
  - 連結が無い FIN は従来どおり `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` で通知される (回帰ガード)
- `CHANGES.md` の `## develop` 先頭に `[FIX]` を追記した

### 検証

- `npx vp check` / `npx vp test --run` (122 files / 2498 tests) が通る
- 変異テストで、連結分を渡さない / initialMessages を read の後で処理する / 先頭読み取りで reader を作り直す / 未応答数の復元を削除する / PUBLISH_DONE 分岐を削除する、のいずれでも対応するテストが失敗することを確認した

## 残した課題

- `initialMessages` の `impl.state === "active"` ガードは、購読が active でない状態を作る経路がテストから辿れないため固定できていない (PUBLISH_OK の書き込み中に unsubscribe する競合)
- 要求側 `bidiReadRequestStreamMessages` は `initialMessages` を未応答数の記録・復元の対象にしておらず、受信側と非対称である。連結チャンクの REQUEST_UPDATE で過剰に `TOO_MANY_REQUEST_UPDATES` で閉じる可能性があり、別途扱う
- 同じ `src/session/incomingPublish.ts` を対象にする 0644 とは同時に進めない (サブループの PUBLISH_DONE 分岐とピア FIN 分岐が対象)
