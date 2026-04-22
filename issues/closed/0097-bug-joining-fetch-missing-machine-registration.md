# Joining FETCH が SessionMachine に登録されず FETCH_OK 受信で PROTOCOL_VIOLATION になる

Created: 2026-04-22
Completed: 2026-04-22
Model: Claude Opus 4.7

## 概要

`Session.sendJoiningFetch` が sans-I/O な `SessionMachine` に FETCH 送信を記録していなかったため、
サーバから FETCH_OK を受信した瞬間に `handlePeerFetchOk` が「unknown request id」と判定して
PROTOCOL_VIOLATION (0x3) でセッションを閉じてしまっていた。

## 再現手順

1. moqt-devtools で Publisher を起動する
2. その後 Subscriber を起動する (内部的に `joiningFetch` 経路で FETCH を送る)
3. SUBSCRIBE_OK → FETCH 送信 → FETCH_OK 受信直後に Session Closed となり
   "Session is closed" が devtools に表示される

Subscriber → Publisher の順で起動した場合は joiningFetch が走らない経路に入るため再現しない。

## 期待する動作

FETCH_OK 受信後もセッションが維持され、FETCH_HEADER / OBJECT の取り込みが継続すること。

## 実際の動作

FETCH_OK 受信直後に以下のエラーでセッションが閉じる。

```
FETCH_OK received for unknown request id
code: PROTOCOL_VIOLATION (0x3)
```

## 原因

`Session.sendJoiningFetch` (`src/session/session.ts`) が `Fetch` メッセージを組み立ててから
`encodeFetchPayload` で直接エンコードしており、通常の `fetch()` / `trackStatus()` / `subscribe()`
などが行っている以下 2 行の SessionMachine への登録を行っていなかった。

```ts
this.protocol!.sendFetch(fetchMsg);
this.protocol!.nextEvent();
```

結果、FETCH_OK を受けた SessionMachine 側で対応する fetch エントリが見つからず、
`handlePeerFetchOk` が `PROTOCOL_VIOLATION` を積んでセッションが閉じられていた。

## 解決方法

`Session.sendJoiningFetch` に `this.protocol!.sendFetch(fetchMsg)` と
`this.protocol!.nextEvent()` を追加し、他の送信経路と同じく SessionMachine に
FETCH 送信を記録するようにした。

リグレッション防止として `src/session/fetch.prop.ts` に
`sendFetch(RELATIVE_JOINING)` / `sendFetch(ABSOLUTE_JOINING)` 後に FETCH_OK を受信しても
`closeSession` イベントが積まれないこと (= `established` に遷移すること) を検証するテストを追加した。
