# 同一 Track への複数同時サブスクリプションに対応する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-multiple-subscriptions-per-track
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 5.1 (Subscriptions) で、同一 Track への複数同時サブスクリプションが許可された。変更履歴は Appendix A.1 `#1775`。

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
> a received Object belongs to. Subscribers SHOULD avoid overlapping
> filters across subscriptions to the same Track, as they are
> responsible for deduplicating any resulting duplicate Objects.

REQUEST_ERROR コード `DUPLICATE_SUBSCRIPTION` は draft-19 のエラーコード表（Section 15.11.2）から削除されている。コードポイント `0x19` は Session 側の `INVALID_AUTHORITY` に割り当てられている。

異なる Track に同一 Track Alias を使うことは引き続き禁止である。

draft-19 Section 11.1 (Track Alias):

> The same Track Alias MUST NOT be used by a publisher to refer to two
> different Tracks simultaneously in the same session. If a subscriber
> receives a PUBLISH or SUBSCRIBE_OK that uses the same Track Alias as
> a different Track with an Established subscription, it MUST close the
> session with error DUPLICATE_TRACK_ALIAS.

Track の同一性は Full Track Name（Track Namespace の全フィールド + Track Name）の等価で判定する（Section 2.4.1）。

## 優先度根拠

High。相互運用問題がある。

- 削除された `DUPLICATE_SUBSCRIPTION` を送信する
- 同一 Track・同一 Track Alias の正当な 2 本目でセッションを `DUPLICATE_TRACK_ALIAS` で閉じる

受信オブジェクトのルーティング設計変更を伴い作業規模も大きい。

## 現状

シンボル名を正とする。

壊れているケース / 既に通るケース:

| ケース | 現状 |
| --- | --- |
| 同一 Track・異なる alias の複数 SUBSCRIBE | `subscribe()` に同一 Track 禁止は無く、alias が違えば Map 衝突しないため概ね動く |
| 同一 Track・同一 alias の複数 SUBSCRIBE_OK | `bidi.ts` が無条件 `DUPLICATE_TRACK_ALIAS` でセッション切断 |
| 同一 Track・同一 alias の 2 本目 PUBLISH | `subscribersByAlias.has(alias)` なら `DUPLICATE_SUBSCRIPTION` で拒否（Track 同一性を見ていない） |
| 異 Track・同一 alias の PUBLISH / SUBSCRIBE_OK | Section 11.1 どおりセッション終了すべきだが、PUBLISH 側は `DUPLICATE_SUBSCRIPTION`（誤ったコード）を返す |

主な実装:

- `src/session.ts`: `subscribersByAlias = new Map<bigint, SubscriberImpl>()`（alias 1:1）。datagram / subgroup は単一 subscriber へ配送
- `SubscriberImpl` は Location Filter を保持せず、`handleObject` / `handleDatagram` は無条件配送
- `src/session/bidi.ts`: SUBSCRIBE_OK で既存 alias なら `DUPLICATE_TRACK_ALIAS`。cancel / finally は `subscribersByAlias.delete(trackAlias)` 一括削除
- `src/error.ts`: `DUPLICATE_SUBSCRIPTION: 0x19` を定義（draft-19 では REQUEST_ERROR から削除済み）
- client-as-publisher: 受信 SUBSCRIBE 処理は無く、`publish()` は `nextTrackAlias++` で常に別 alias。送信キューも alias キー

closed `#0317` の「重複 PUBLISH → DUPLICATE_SUBSCRIPTION」は draft-18 前提であり、本 issue が draft-19 で上書きする。

## 設計方針

採用するデータ構造: **requestId を主キーとし、alias → requestId の多重インデックス**（配列でも同等なら可。実装時に一方に寄せる）。

受信側（subscriber）:

- Location Filter の保存元を次に限定する（Section 10.2.9: LOCATION_FILTER は SUBSCRIBE / PUBLISH_OK / REQUEST_UPDATE のみ。PUBLISH には載らない）
  - SUBSCRIBE 起点: 送信時の `options.filter`
  - PUBLISH 起点: こちらが送る PUBLISH_OK に載せた filter。現状は `parameters: []` のため常に unfiltered（全 Object 通過）。本 issue で PUBLISH_OK に filter を載せる API は必須としない（未載荷＝unfiltered のまま）
- filter 省略 / unfiltered は全 Object 通過とする
- Location Filter 再適用の判定（Section 5.1.2）:
  - 通過条件: Object Location ≥ Start。End Group があるときは Group ≤ End Group
  - AbsoluteRange の End Group は `Start.Group + End Group Delta`（Delta = 0 は当該 Group の残りが通過）
  - `LargestObject` / `NextGroupStart` は SUBSCRIBE_OK（または REQUEST_UPDATE_OK）の `LARGEST_OBJECT` で Start を解決（未配信なら `{0,0}`）
  - Object×Filter マッチは純関数として切り出し、単位テスト可能にする（現状は encode/decode のみ）
- REQUEST_UPDATE 後の filter 更新:
  - REQUEST_UPDATE の parameters に LOCATION_FILTER があれば抽出して置換。省略なら不変（Section 10.2.9 / 10.9。削除手段なし）
  - 相対 Filter を再指定した場合は REQUEST_UPDATE_OK の `LARGEST_OBJECT` で Start を再解決し得る（Section 10.9.1）
- datagram / subgroup / `processSubgroupObjects`（`src/session/stream.ts`）の配送を、alias に紐づく全 subscription への filter 再適用に変更する（Section 5.1）
- 重なり filter による重複 Object の dedupe はアプリ責任（Section 5.1 SHOULD）。ライブラリでは dedupe しない
- Range Filters（`#0341`）の再適用は本 issue スコープ外。Location Filter のみ
- alias 衝突: Full Track Name が異なる Established が同じ alias → `DUPLICATE_TRACK_ALIAS` でセッション終了。同一 Track ならリスト追加（Section 11.1）
- PUBLISH 受信: `DUPLICATE_SUBSCRIPTION` 拒否を撤廃。上記 Track 同一性判定に置き換える
- 削除: requestId 単位で取り除き、その alias に他 subscription が無ければエントリ削除。`delete(trackAlias)` 一括削除をやめる
- `BidiSessionInternal.subscribersByAlias` など型定義も多重化に追従する
- `RequestErrorCode.DUPLICATE_SUBSCRIPTION` を削除する

client-as-publisher（送信側）のスコープ:

- **本 issue では自動 fan-out を実装しない**。現行 API はアプリが各 `Publisher` に `sendObject` する前提であり、受信 SUBSCRIBE の自動多重配送は別設計になる
- Section 5.1 の publisher MUST（マッチする各 subscription へ 1 回ずつ）は、将来の受信 SUBSCRIBE 対応または別 issue で扱う。本 issue の完了条件に含めない

依存・境界:

- `#0340`（LOCATION_FILTER リネーム）: 識別子名は本変更時点の名前に追従。リネーム未完了なら旧名のまま触り、0340 が後で直す
- `#0341`（Range Filters）: 本 issue では扱わない
- `#0343`: 本変更で触ったコメントのみ更新。全体置換は 0343

## 完了条件

- 同一 Track に対して 2 本の SUBSCRIBE を発行し、それぞれの requestId で独立にオブジェクトを受信できるテストがあること（alias 共有・alias 別々の両ケース）。配置は既存 e2e（`tests/e2e/`）または抽出可能な filter マッチの単位テスト。モック禁止
- 共有 alias で一方を unsubscribe しても、他方が受信を継続すること
- 同一 Track への 2 本目の PUBLISH 受信が拒否されないこと
- 異なる Track（Full Track Name 不一致）への同一 alias 割り当ては `DUPLICATE_TRACK_ALIAS` でセッションが閉じること（SUBSCRIBE_OK / PUBLISH の双方）
- `DUPLICATE_SUBSCRIPTION` がコードベースから削除されていること
- Location Filter 再適用により、共有 alias でも各 subscription の filter に合う Object だけが届くこと（単位テスト可）
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. Object Location × Location Filter のマッチ純関数を追加する（Start 解決・End Group 判定を含む）。単位テストを付ける
2. `SubscriberImpl`（または同等）に解決済み Location Filter を保持する。SUBSCRIBE 送信時の `options.filter` と、REQUEST_UPDATE 成功後の更新経路を実装する
3. `subscribersByAlias` / `BidiSessionInternal` を多重化（requestId 主キー + alias インデックス）。追加 / 削除 / 空エントリ掃除を実装する
4. `src/session/bidi.ts`: SUBSCRIBE_OK の alias 衝突を「異 Track のみ DUPLICATE_TRACK_ALIAS」に変更。cancel / finally を requestId 単位削除に変更
5. `src/session.ts` / `src/session/stream.ts`: PUBLISH 受信の `DUPLICATE_SUBSCRIPTION` を撤廃し Track 同一性判定に置換。datagram / subgroup / `handleSubgroupStream` / `processSubgroupObjects` を複数 subscription + filter 再適用に変更
6. `src/error.ts`: `DUPLICATE_SUBSCRIPTION` を削除。参照箇所をすべて除去
7. 共有 alias / 異 Track alias / unsubscribe 残存は e2e または session 層テストで確認
8. 触った箇所の仕様参照を draft-19 Section 5.1 / 5.1.2 / 11.1 に更新
9. `CHANGES.md` に `[CHANGE]` を追記
10. `vp check` / `tsc --noEmit` / `vp test run` で確認
