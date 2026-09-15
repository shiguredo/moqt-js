# FETCH リクエストストリーム上の REQUEST_UPDATE を検出しない

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-fetch-stream-request-update
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §9.5 は、REQUEST_UPDATE を受け取れるのは「リクエストの送信者」と「PUBLISH で確立した購読の subscriber」の 2 ケースのみとし、それ以外は PROTOCOL_VIOLATION で閉じる MUST を定める。FETCH 応答ストリームは FETCH_OK 受理後に読み取りが継続されないため、逸脱したピアの REQUEST_UPDATE を検出できない。

## 現状

- `bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の呼び出しは publish 応答経路と subscribe 応答経路の 2 箇所のみで、FETCH 応答経路にはない
- FETCH_OK 受理後もストリームは `requestStreams` に残るが、以降メッセージを読まない
- moqt-js は FETCH の REQUEST_UPDATE を送る API を持たない (`Fetcher` に更新 API がない) ため、受信側の検出だけが欠けている
- §9.5 の 2 ケースに照らすと、FETCH の responder からの REQUEST_UPDATE は該当しない

draft-ietf-moq-transport-21 §9.5:

> An endpoint that receives a REQUEST_UPDATE other than in the two cases above MUST close the session with a PROTOCOL_VIOLATION.

## 設計方針

- FETCH_OK 受理後も当該ストリームの読み取りを継続し、REQUEST_UPDATE を受信したら PROTOCOL_VIOLATION で閉じる
- 他のメッセージは既存の想定外応答処理に委ねる
- FIN と 2 通目 GOAWAY の検出など、publish / subscribe の読み取りループと同じ扱いに揃える
- 読み取りを継続しても FETCH の正常系 (FETCH_OK → Fetch Object → FIN) の挙動が変わらないことを確認する

## 完了条件

- FETCH 応答ストリーム上の REQUEST_UPDATE が PROTOCOL_VIOLATION になる
- FETCH の正常系が変わらない
- ストリーム終端と GOAWAY の扱いが既存経路と揃う
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §9.5 (REQUEST_UPDATE)
- draft-ietf-moq-transport-21 §9.11 (FETCH)
- draft-ietf-moq-transport-21 §9.12 (FETCH_OK)
- draft-ietf-moq-transport-21 §6.4.2.2 (Graceful Request Stream Closure)
