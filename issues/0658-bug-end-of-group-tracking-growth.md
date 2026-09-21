# END_OF_GROUP の最終 Object ID 追跡が Group ごとに増え続ける

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-end-of-group-tracking-growth
- Polished: {YYYY-MM-DD}

## 目的

`src/session/dataStreamIncoming.ts` は確定した Group の最終 Object ID を `${trackAlias}:${groupId}` キーで `session.receivedEndOfGroupFinalObjectIds` に記録する。この Map のエントリは購読が終わるまで 1 件も破棄されないため、長時間の購読では Group 数に比例して増え続ける。同じ受信追跡である `src/session/priorGapTracking.ts` は上限を持っており、扱いが非対称である。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` が `dataStreamProcessSubgroupObjects` の戻り値 `updatedEndOfGroupFinalObjectId` を `${trackAlias}:${groupId}` キーで `session.receivedEndOfGroupFinalObjectIds` に set する
- `src/session/incoming.ts` の `incomingProcessSubgroupObjects` が同じキーで読み出し、draft-ietf-moq-transport-21 §12.1 条件 4 (Group の最終 Object より大きい Object ID の検出) に使う
- 破棄するのは `src/session/bidi.ts` の `clearEndOfGroupTracking` だけで、呼ばれるのは `deleteSubscriber` と `bidiCancelSubscription` の「その Track Alias の購読が 0 件になったとき」に限る。セッション終了時は `src/session/lifecycle.ts` の `sessionClose` が全消しする
- つまり購読が続く限り Group ごとに 1 エントリ (キー文字列 + bigint) が残る。1 Group/秒で配信される Track を 24 時間購読すると約 86,400 エントリになる
- `src/session/priorGapTracking.ts` は `MAX_TRACKED_GROUP_IDS` / `MAX_TRACKED_OBJECT_IDS_PER_GROUP` / `MAX_TRACKED_GAP_RANGES` / `MAX_TRACKED_TRACKS` で上限を切り、超えた分を最古から破棄する。同じ Group 単位の受信追跡でありながら、上限が無い側がある

## 設計方針

- 上限付きの保持にする (最古の Group から破棄する) か、Group 状態を `priorGapTracking` 側へ統合して Group 単位でまとめて破棄する。後者は追跡の置き場所と上限の実装が 1 つで済む
- 上限を設ける場合は、破棄した Group では §12.1 条件 4 の検出ができなくなる (誤検出はしないが検出漏れは起こり得る) ことを JSDoc に明記する
- キー文字列の生成をやめる場合は Track Alias と Group ID の 2 段 Map にし、alias 単位の破棄を 1 操作にする

## 完了条件

- 長時間購読でエントリが増え続けないことがテストで固定される
- 追跡を破棄した Group で検出できなくなる条件が JSDoc に書かれている
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
