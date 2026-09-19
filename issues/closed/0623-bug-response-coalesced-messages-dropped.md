# 応答と同一 chunk の PUBLISH_OK / SUBSCRIBE_OK 連結メッセージを取りこぼす

- Created: 2026-09-20
- Completed: 2026-09-20
- Branch: feature/fix-subscribe-response-coalesced-messages

## 目的

制御メッセージは単一の双方向ストリーム上で Length プレフィックスにより連続して
運ばれるため、最初の応答と後続メッセージが同一の chunk に同居し得る。
`bidiDispatchResponse` は最初の応答チャンクに連結されていた 2 通目以降を
`context.remainingMessages` に保持するが、これを読み取りループへ引き渡しているのは
FETCH 経路だけで、PUBLISH 経路と SUBSCRIBE 経路は引き渡していない。

ControlStreamReader は取り出したメッセージをバッファから削除するため、渡さなければ
そのチャンクの 2 通目以降は復元できず永久に失われる。Sora の Media over QUIC
実装でありリレー機能を提供する sora-moq は、PUBLISH_OK の直後に
`REQUEST_UPDATE (FORWARD=1)` を同一 chunk で送るため、publisher の Forward State が
0 のままになり Objects が 1 つも送られない。実際に sora-moq リレー経由の配信が
開始されない事象として現れた。

## 現状

- `src/session/bidi.ts` の `bidiReadPublishResponse` の `handleOk` は
  `bidiReadRequestStreamMessages` に `context.remainingMessages` を渡していない
- `src/session/bidi.ts` の `bidiReadSubscribeResponse` の `handleOk` も同様に
  渡していない
- `bidiReadFetchResponse` の `handleOk` は渡しており、`bidiReadRequestStreamMessages`
  の `initialMessages` 引数は最初の応答チャンクの残りを先頭から処理する実装に
  なっている。3 経路のうち 2 経路だけが引数を省略している状態である
- 連結された `REQUEST_UPDATE` / `PUBLISH_DONE` / `PUBLISH_STATE_NOTIFY` は
  読み取りループに届かず、応答の 1 通だけが処理されて残りは捨てられる
- テストヘルパー `src/testSupport/bidi.ts` は `pendingSubgroupBuffer` に
  空オブジェクトを渡している。SUBSCRIBE_OK の受理経路は
  `session.pendingSubgroupBuffer.notifyAlias()` を必ず呼ぶため、この状態では
  TypeError が発生し、`defaultBidiHandleError` に握り潰されて `pending.resolve` と
  読み取りループの起動に到達しないままテストが通ってしまう。SUBSCRIBE_OK の
  正常系を検証しているつもりのテストが、実際には応答処理の途中で失敗していた

## 設計方針

- PUBLISH 経路と SUBSCRIBE 経路の `bidiReadRequestStreamMessages` 呼び出しに
  `context.remainingMessages` を渡す。FETCH 経路と同じ扱いに揃え、role ごとの
  分岐は読み取りループ側 (`bidiProcessRequestStreamMessages`) に委ねる
- テストヘルパーの `pendingSubgroupBuffer` を実物の `PendingSubgroupBuffer` に
  置き換え、SUBSCRIBE_OK の受理経路が最後まで実行されるようにする
- 応答と連結したメッセージが実際に処理されることを検証する回帰テストを追加する。
  連結分が失われると結果が変わる検証 (Forward State の遷移、PUBLISH_DONE の通知、
  LARGEST_OBJECT の更新) にする

## 完了条件

- PUBLISH_OK と同一 chunk の `REQUEST_UPDATE` が処理され、`FORWARD` の値が
  publisher の Forward State に反映され、`REQUEST_OK` が 1 通応答される
- SUBSCRIBE_OK と同一 chunk の `PUBLISH_DONE` が処理され、購読の終了が
  アプリへ通知される
- SUBSCRIBE_OK と同一 chunk の `PUBLISH_STATE_NOTIFY` が処理され、購読状態
  (LARGEST_OBJECT) に反映される
- 上記 3 件の回帰テストがあり、`context.remainingMessages` を渡さない状態では
  失敗する
- `npx tsc --noEmit` / `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §6.4.2 (Request Streams)
- draft-ietf-moq-transport-21 §9.3 (REQUEST_OK)
- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.10 (PUBLISH_STATE_NOTIFY)
- draft-ietf-moq-transport-21 §9.20.19 (FORWARD Parameter)
- draft-ietf-moq-transport-21 §11.3.1 (Subgroup Header)

## 解決方法

### `context.remainingMessages` の引き渡し

`src/session/bidi.ts` の `bidiReadPublishResponse` と `bidiReadSubscribeResponse` の
`handleOk` から `bidiReadRequestStreamMessages` を呼ぶ箇所に
`context.remainingMessages` を渡すようにした。FETCH 経路と同じ扱いになり、role ごとの
分岐は読み取りループ側 (`bidiProcessRequestStreamMessages`) が担う。

### テストヘルパーの `pendingSubgroupBuffer`

`src/testSupport/bidi.ts` の 6 箇所の `pendingSubgroupBuffer: {}` を実物の
`PendingSubgroupBuffer` に置き換えた。SUBSCRIBE_OK の受理経路は
`session.pendingSubgroupBuffer.notifyAlias()` を必ず呼ぶため、空オブジェクトでは
TypeError になり、`defaultBidiHandleError` に握り潰されて `pending.resolve` と
読み取りループの起動に到達しないままテストが通っていた。実物にすることで
SUBSCRIBE_OK の正常系が最後まで実行されるようになる。

### テスト

`src/session/bidiRequestStreamInitialMessages.test.ts` を追加した (4 件)。

- PUBLISH_OK と同一 chunk の `REQUEST_UPDATE (FORWARD=1)` が処理され、publisher の
  Forward State が 1 になり `REQUEST_OK` が 1 通応答される
- PUBLISH_OK と同一 chunk の `REQUEST_UPDATE (FORWARD=0)` が処理され、Forward State が
  0 になる
- SUBSCRIBE_OK と同一 chunk の `PUBLISH_DONE` が処理され、購読の終了が通知される
- SUBSCRIBE_OK と同一 chunk の `PUBLISH_STATE_NOTIFY` が処理され、LARGEST_OBJECT が
  購読状態に反映される

いずれも `context.remainingMessages` を渡さない状態では失敗することを確認した
(4 件すべて失敗する)。

`src/session/bidiResponseScopeViolation.test.ts` の SUBSCRIBE_OK 正常系テストは、
これまで `notifyAlias` の TypeError で読み取りループが起動していなかったため
ストリームを閉じても何も起きなかった。実物のバッファにしたことで読み取りループが
起動し、PUBLISH_DONE 無しの FIN が購読の失敗として扱われるようになった。
同テストは確立中の購読での Location Filter の確定だけを検証するため、検証が終わる
までストリームを閉じない形に変更した。

### 検証

- `npx vp check` (287 files / 908 files)
- `npx vp test --run` (2400 passed)
- `CHANGES.md` の `## develop` に [FIX] エントリを追加
