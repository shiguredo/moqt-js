# 同一 Track への複数同時サブスクリプションに対応する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-multiple-subscriptions-per-track
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 5.1 (Subscriptions) で、同一 Track への複数同時サブスクリプションが許可された。変更履歴は Appendix A.1 `#1775` ("Allow multiple concurrent subscriptions per Track")。

draft-19 Section 5.1:

> An endpoint MAY have multiple concurrent subscriptions to the same
> Track, each identified by a unique Request ID. A publisher MAY
> assign the same or different Track Aliases to these subscriptions.
>
> When an Object matches the filters of multiple subscriptions to the
> same Track, the publisher MUST send the Object once for each matching
> subscription, even when those subscriptions share the same Track
> Alias. Because subscriptions can share a Track Alias, the subscriber
> re-applies each subscription's filter to determine which subscription
> a received Object belongs to.

これに伴い、REQUEST_ERROR コード DUPLICATE_SUBSCRIPTION (0x19) は draft-19 のエラーコード表から削除されている。

一方、異なる Track に同一 Track Alias を使うことは引き続き禁止である。

draft-19 Section 11.1 (Track Alias):

> The same Track Alias MUST NOT be used by a publisher to refer to two
> different Tracks simultaneously in the same session. If a subscriber
> receives a PUBLISH or SUBSCRIBE_OK that uses the same Track Alias as
> a different Track with an Established subscription, it MUST close the
> session with error DUPLICATE_TRACK_ALIAS.

moqt-js は draft-18 の「同一 Track は 1 本まで」制約を実装しているため、draft-19 準拠ピアが同一 Track に 2 本目を確立しようとすると拒否またはセッション切断してしまう。

## 優先度根拠

削除されたエラーコード (DUPLICATE_SUBSCRIPTION) を送信する、同一 Track・同一 Track Alias の正当な 2 本目でセッションを閉じる、という相互運用問題があるため High。受信オブジェクトのルーティング設計変更を伴い作業規模も大きい。

## 現状

- `src/session.ts`: `subscribersByAlias = new Map<bigint, SubscriberImpl>()`。Track Alias と subscriber が 1:1 前提で datagram / subgroup をルーティングしている
- `src/session/bidi.ts`: SUBSCRIBE_OK で既存 alias と衝突したら DUPLICATE_TRACK_ALIAS でセッションを閉じる。同一 Track への 2 本目が同じ alias を割り当てられた正当なケースも誤って落とす
- `src/session.ts`: PUBLISH 受信時、既存 alias があれば `RequestErrorCode.DUPLICATE_SUBSCRIPTION` を返して拒否する
- `src/error.ts`: `DUPLICATE_SUBSCRIPTION: 0x19` を定義 (draft-19 では削除済み)
- `subscribe()` はリクエストごとに一意の requestId を採番しており、送信側は既に複数サブスクリプションを発行できる

## 設計方針

- `subscribersByAlias` を「alias → subscriber の配列」(または requestId ベースの管理 + alias インデックス) に変更し、同一 alias を共有する複数サブスクリプションを保持できるようにする
- 受信オブジェクトのルーティングで、alias が複数サブスクリプションに紐づく場合は各サブスクリプションのフィルタを再適用して該当するものに配送する (Section 5.1)
- alias 衝突検出は「異なる Track に同一 alias が割り当てられた場合」のみ DUPLICATE_TRACK_ALIAS とし、同一 Track での alias 共有は許容する (Section 11.1)
- DUPLICATE_SUBSCRIPTION による PUBLISH 拒否を撤廃し、同一 Track への複数 PUBLISH を受け入れる
- `RequestErrorCode.DUPLICATE_SUBSCRIPTION` (0x19) の定義を削除する
- client-as-publisher 側で、同一 Track に複数サブスクリプションを受けた場合に「マッチする各サブスクリプションへオブジェクトを 1 回ずつ送る」動作を実現する
- 仕様参照コメントを draft-19 Section 5.1 (Subscriptions) / Section 11.1 (Track Alias) に更新する

## 完了条件

- 同一 Track に対して 2 本の SUBSCRIBE を発行し、それぞれの requestId で独立にオブジェクトを受信できるテストがあること (alias 共有・alias 別々の両ケース)
- 同一 Track への 2 本目の PUBLISH 受信が拒否されないテストがあること
- 異なる Track への同一 alias 割り当ては引き続き DUPLICATE_TRACK_ALIAS でセッションが閉じること
- `DUPLICATE_SUBSCRIPTION` がコードベースから削除されていること
- lint / build / typecheck / 既存テストが通ること
