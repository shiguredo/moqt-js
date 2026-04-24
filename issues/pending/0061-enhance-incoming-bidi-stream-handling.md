# サーバーからの双方向ストリーム受信を実装する

Created: 2026-03-29
Model: Opus 4.6

## 概要

サーバーからクライアントへの双方向ストリームによるリクエスト (SUBSCRIBE, PUBLISH 等) の受信が未実装である。

## RFC 根拠

draft-ietf-moq-transport-17 Section 3.3 Session initialization:

> In addition to the control streams, this specification uses bidirectional streams to carry requests. A request stream begins with one of these six message types: TRACK_STATUS, SUBSCRIBE, PUBLISH, FETCH, PUBLISH_NAMESPACE, and SUBSCRIBE_NAMESPACE. Bidirectional streams MUST NOT begin with any other message type unless negotiated. If they do, the peer MUST close the Session with a PROTOCOL_VIOLATION. Objects are sent on unidirectional streams.

draft-ietf-moq-transport-17 Section 5.1 Subscriptions:

> Either endpoint can initiate a subscription to a track without exchanging any prior messages other than SETUP.

双方向ストリームを開く側にクライアント/サーバーの制限はなく、サーバーもクライアントに対してリクエストを送信可能である。現在の実装では `incomingBidirectionalStreams` のリスナーが存在しないため、サーバーからのリクエストを処理できない。

## 該当箇所

- `src/session.ts`: `incomingBidirectionalStreams` の監視がない

## 修正方針

`incomingBidirectionalStreams` を監視し、受信した双方向ストリームの最初のメッセージタイプに基づいて適切なハンドラにディスパッチする。サーバーからの SUBSCRIBE / PUBLISH 等に対応するコールバックを SessionCallbacks に追加する。

## pending 理由

この変更はクライアント専用設計からの大幅な変更を伴う。サーバーからの SUBSCRIBE に対して Publisher として応答する、サーバーからの PUBLISH に対して Subscriber として応答する等、全フローの追加が必要であり、設計判断を要する。以下の検討事項がある:

- SessionCallbacks にサーバーからのリクエストに対応するコールバック (onSubscribe, onPublish 等) を追加する必要がある
- サーバーからのリクエストの Request ID は奇数 (LSB=1) であるため、ID 管理の修正も必要
- 現状のユースケース (ブラウザクライアント) ではサーバーからのリクエスト受信は稀であり、優先度は低い

## 調査結果

**現行アーキテクチャでは未対応かつ scope 外寄り**

- `README.md` では `moqt-js` を「ブラウザ向けの MOQT クライアントライブラリ」として位置付けており、現在のプロダクトスコープはクライアント専用である。
- `src/session.ts` の `initialize()` はクライアントとして送信用単方向制御ストリームを開き、受信側ではサーバーからの `incomingUnidirectionalStreams` を 1 本受けて制御ストリームにし、その後も単方向ストリームと datagram だけを監視する。
- `src/session.ts` 全体を確認しても `incomingBidirectionalStreams` を監視するループは存在しない。双方向ストリームは `sendRequestOnBidiStream()` でクライアント側から開く用途に限定されている。
- `src/session.ts` の `nextRequestId` は `0n` から始まり `+2n` で増加しており、クライアント発の偶数 Request ID だけを前提にしている。サーバー発の奇数 Request ID を受ける設計にはなっていない。
- `src/message/publish.ts` / `src/message/subscribe.ts` / `src/message/fetch.ts` にはサーバー側 codec があるが、コメントでも「クライアント専用のためランタイムでは使用しない」と明記されている。
- 以上から、この issue は単純な受信ループ追加ではなく、クライアント専用アーキテクチャを広げる設計変更になる。

## 今どうするべきか

- 現在のスコープでは、この issue は「未実装の機能」というより「現行方針の対象外」に近い。
- そのため、いま直ちに実装へ進めるのではなく、クライアント専用方針が変わるまで `issues/pending/` のまま維持するのが妥当である。
- もし将来対応するなら、1 つの issue で扱わず、`incomingBidirectionalStreams` の受信ループ、サーバー起点リクエスト用 API、奇数 Request ID の管理、各リクエスト種別ごとのフロー実装に分割して進めるべきである。
