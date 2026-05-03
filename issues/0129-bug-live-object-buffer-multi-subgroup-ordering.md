# liveObjectBuffer が複数 Subgroup ストリームの到着順を保証していない

Created: 2026-05-03
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts:508-510` の `liveObjectBuffer` 処理に「stream 内では順番が保証されるのでソート不要」とコメントされているが、SUBSCRIBE のデータは複数 Subgroup ストリームと OBJECT_DATAGRAM の混合で到着し得るため、FIFO バッファでは `(groupId, objectId)` の順序が保証されない。

`useSubscriber.ts:614-625` の object コールバックは:

```ts
object: (obj: MoqtObject) => {
  ...
  if (instance.joiningFetchInProgress) {
    const newBuffer = [...instance.liveObjectBuffer, obj];
    sub.updateSubscriber(subscriberId, {
      liveObjectBuffer: newBuffer,
    });
    return;
  }
  liveObjectProcessingChain = liveObjectProcessingChain.then(() => handleObject(obj));
},
```

オブジェクトを到着順にバッファし、`onEnd` 後に同じ順でデコーダへ流す。しかし draft-ietf-moq-transport-17 §10.3 / §10.4 では Subgroup ストリームと Datagram は並列で配送されるため、複数 Subgroup を使う Publisher と接続した場合に到着順 ≠ Group/Object 順となり、デコード順が崩れて WebCodecs がエラーになる。

`liveObjectProcessingChain` 経路 (`useSubscriber.ts:628`) も同様で、到着順そのままを順次デコードしているため Subgroup 並列性に対応していない。

## RFC 根拠

draft-ietf-moq-transport-17 §10.3 (l.4475-4485):

> Subgroups and datagrams are independent: an Object can be sent in either form, but not both. Multiple subgroups within a Group are delivered on independent streams, and the Subgroup ID conveys the relative ordering between them.

§10.4.1 (l.4694-4708) でも、Subgroup ストリームは Group 内で独立しており、Subscriber 側で reorder と merge を行う前提と読める。

§10.4.2 (l.4720-4726) は Track Alias 未確立 Subgroup の reorder 吸収について abandon / buffer の選択肢を示しているが、これは確立後の Subgroup 並列性の話とは別レイヤー。確立後の Subgroup 間 reorder は Subscriber が `(groupId, subgroupId, objectId)` で並べ替える必要がある。

## 該当箇所

- `devtools/src/hooks/useSubscriber.ts:508-510` — 「stream 内では順番が保証されるのでソート不要」のコメントと前提
- `devtools/src/hooks/useSubscriber.ts:566-582` — ドレインループの単純 FIFO 処理
- `devtools/src/hooks/useSubscriber.ts:614-628` — object コールバックのバッファ追加と直接処理経路

## 期待される動作

最低でも以下のいずれかを実装する。優先度は (1) > (2):

1. **Subgroup 単位バッファ + group/object 順マージ**: バッファを `Map<(groupId, subgroupId), MoqtObject[]>` に変更し、ドレイン時に `(groupId, objectId)` 昇順でマージしてデコーダへ流す。直接処理経路も同様に短時間 (例: 1 frame 分) のリオーダーバッファを持つ。

2. **単一 Subgroup 前提を明示**: `liveObjectBuffer` 追加時に `subgroupId` をチェックし、複数 Subgroup を検出したら警告を出してデコーダリセットする。コメントを「現状は単一 Subgroup 前提で動作し、複数 Subgroup を受信した場合は未対応」と修正する。

現状の Publisher (devtools) が単一 Subgroup しか使わないため動作していることを issue に明記する。

## 優先度

中。devtools の Publisher と Subscriber を組み合わせた検証では発生しないが、複数 Subgroup を使う相手 (例えば SVC の解像度 / レイヤごとの Subgroup 分け) と接続した瞬間に再生が壊れる。draft-17 準拠の汎用 Subscriber を名乗る上では必須の対応だが、現時点で MOQT 互換実装の検証相手が限られるため対応は (1) ベースで段階的に進める。
