# Joining Fetch 有効時に DATAGRAM_LOOP_ERROR が発生する

- Completed: 2026-10-17

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

## 解決方法

本 issue は、前提となる Joining FETCH がプロトコルから削除され、moqt-js 側にも該当機能が存在しないため closed にする。

- Joining FETCH は draft-ietf-moq-transport-20 で削除された (draft-ietf-moq-transport-22 Appendix A.3「Replace Joining FETCH with fill fetch streams」「Remove the Joining variant of FETCH」)。draft-ietf-moq-transport-22 の FETCH (§9.11) に Fetch Type / Joining / Standalone は存在せず、置換は FILL_PARAMETERS (§9.20.15) による fill fetch stream (§3.4) である (moqt-js では `src/session/params.ts` の `buildFillParameters` と `src/session/dataStreamIncoming.ts` の fill fetch 受信経路で実装済み)。
- moqt-js も Joining FETCH を削除済みで、`FetchType` / `JoiningFetch` / `bidiSendJoiningFetch` は存在しない。`src/message/fetch.ts` は draft-22 §9.11 の FETCH メッセージのみを扱い、devtools の「Joining Fetch」チェックボックスも存在しない。
- したがって、本 issue の再現手順 (devtools で「Joining Fetch」を有効にする) と pending 理由 (リレーの Joining FETCH 対応待ち) は前提が消滅している。
- fill fetch 経路 (FILL_PARAMETERS による fill fetch stream) で同様の症状が出る場合は、現行ワイヤ (draft-22) を前提とした別 issue を起票する。
- 本文の「状況確認 (2026-04-29)」は当時の記録であり、現在の `src/message/fetch.ts` に `FetchType` の定義はない。
