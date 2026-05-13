# Joining Fetch 有効時に DATAGRAM_LOOP_ERROR が発生する

## 概要

Joining Fetch を有効にして Subscribe すると、SUBSCRIBE_OK 受信直後に DATAGRAM_LOOP_ERROR が発生してセッションが切断される。

## 再現手順

1. DevTools で Subscriber を開く
2. "Joining Fetch" チェックボックスを有効にする
3. "Start Subscribing" をクリック

## 期待する動作

- SUBSCRIBE_OK 後に FETCH が送信され、セッションが維持される

## 実際の動作

- SUBSCRIBE_OK と FETCH 送信直後に DATAGRAM_LOOP_ERROR が発生
- セッションが "Disconnected" になる

## デバッグログ

```
[subscriber-1] [SEND] CLIENT_SETUP
[subscriber-1] [RECV] SERVER_SETUP
[subscriber-1] [SEND] SUBSCRIBE
[subscriber-1] [RECV] SUBSCRIBE_OK
[subscriber-1] [SEND] FETCH
[subscriber-1] [RECV] DATAGRAM_LOOP_ERROR
```

## 備考

- Joining Fetch を無効にすると正常に動作する
- WebTransport datagram reader がエラーを投げている (エラーオブジェクトは空 `{}`)

## 調査結果

**リレー側の問題と判断**

- クライアント側の FETCH エンコーディングテストはすべて通過 (`pnpm test`)
- FETCH メッセージのフォーマットは draft-ietf-moq-transport-15 Section 9.16.2 に準拠
- DATAGRAM_LOOP_ERROR は WebTransport 接続が切断されたときに発生
- FETCH 送信直後にエラーが発生しているため、リレーが接続を切断している

**考えられる原因**

1. リレーが Joining FETCH (FetchType 0x02, 0x03) を未実装
2. リレーが FETCH メッセージの処理でプロトコルエラーを検出

**次のアクション**

- リレー側のログを確認して、FETCH 受信時に何が起きているか調査する

## pending 理由

調査の結果、リレー側 (Joining FETCH 未実装、または FETCH 処理でのプロトコルエラー) の問題と判断された。moqt-js 側の FETCH エンコーディングはテストで仕様準拠が確認済み。リレー側での Joining FETCH 対応または原因調査の結果を待つ必要があるため pending とする。

## 状況確認 (2026-04-29)

- `src/message/fetch.ts:23-29` で `FetchType.STANDALONE = 0x01` / `RELATIVE_JOINING = 0x02` / `ABSOLUTE_JOINING = 0x03` を定義。draft-ietf-moq-transport-17 Section 9.16.2 に準拠した値のまま。
- `src/message/fetch.ts:90-170` のエンコード / デコード経路でも Joining 系の `joiningRequestId` / `joiningStart` を扱えており、クライアント側実装に欠落はない。
- リレー側の Joining FETCH 対応状況に関する追加情報は得られていないため、現時点では引き続きリレー側の対応待ちで pending 維持。
