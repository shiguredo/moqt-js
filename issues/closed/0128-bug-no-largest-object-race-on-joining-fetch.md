# LARGEST_OBJECT なしの SUBSCRIBE_OK 経路で joiningFetchInProgress 解除が二重化しレースする

Created: 2026-05-03
Completed: 2026-05-03
Model: Opus 4.7

## 概要

devtools の `useSubscriber.ts` で Joining FETCH を有効にした SUBSCRIBE が SUBSCRIBE_OK で `LARGEST_OBJECT` を含まない応答を受けた場合、`joiningFetchInProgress` フラグを `false` に戻す箇所が 2 箇所あり (`useSubscriber.ts:587` のドレインループ末尾、`useSubscriber.ts:652` の subscribe await 直後)、ライブオブジェクトのバッファドレインと直接処理経路の間でレース条件が発生する。

タイムライン:

1. `useSubscriber.ts:432` で `joiningFetchInProgress: joiningFetchEnabled` を true にする。
2. `session.subscribe()` 内 (`src/session.ts:2967-2993`) で:
   - `subscribers.set()` で Subgroup ストリームのルーティングが有効になる。
   - `pendingSubgroupBuffer.notifyAlias()` で既に到着していた Subgroup を flush する (この時点で onObject が発火し、`joiningFetchInProgress=true` のためバッファに積まれる)。
   - LARGEST_OBJECT なし → `pending.joiningFetch.onEnd?.()` を **同期呼び出し**。
   - `pending.resolve(pending.impl)` で SUBSCRIBE_OK Promise を解決。
3. `onEnd` (`useSubscriber.ts:497-588`) は `liveObjectBuffer` をスナップショットしてクリアし、`void (async () => {...})()` でドレインを背景実行する。
4. `await session.subscribe()` が解決し、`useSubscriber.ts:652` で `joiningFetchInProgress: false` を即時セット。
5. ドレインループ (`useSubscriber.ts:566-588`) は while ループで追加分も処理してから末尾で再度 `joiningFetchInProgress: false` をセット。

問題は手順 4 と 5 の競合。手順 4 が先に走ると、手順 5 のドレインループ中に新規ライブオブジェクトが直接 `handleObject` 経路 (`useSubscriber.ts:628`) に流れ、ドレイン対象の古いオブジェクトより前にデコーダへ入る可能性がある。デコーダはキーフレーム待ち状態でなければ delta から食わされて壊れる。

## RFC 根拠

draft-ietf-moq-transport-17 §9.14.2 の Joining Fetch は、関連 SUBSCRIBE が Established になった時点で「FETCH 範囲」と「SUBSCRIBE の live 範囲」が contiguous に定まる。Subscriber 側は両経路から受信したオブジェクトを `(groupId, objectId)` 順に処理する責務を負う。フラグ管理の不備で順序が壊れる実装は仕様適合の前提を破る。

§9.14.2 (l.3941-3942):

> If no Objects have been published for the track the publisher MUST respond with a REQUEST_ERROR with error code INVALID_RANGE.

つまり draft-17 では「LARGEST_OBJECT なしの SUBSCRIBE_OK」を Joining FETCH と組み合わせる経路自体が想定されておらず (publisher 側は INVALID_RANGE を返すべき)、Subscriber が Joining Fetch を要求しているのに LARGEST_OBJECT なしで応答が返るのは publisher の実装不備か Track が未公開状態。それでも client 側で `onEnd` を呼んで状態を整合させるのは許容される。

## 該当箇所

- `devtools/src/hooks/useSubscriber.ts:432` — `joiningFetchInProgress: joiningFetchEnabled` 初期化
- `devtools/src/hooks/useSubscriber.ts:566-588` — ドレインループと末尾の `joiningFetchInProgress: false`
- `devtools/src/hooks/useSubscriber.ts:650-656` — LARGEST_OBJECT なし時の早期 `joiningFetchInProgress: false`
- `src/session.ts:2977-2993` — SUBSCRIBE_OK 受信時の Joining FETCH 起動 / `onEnd` 同期呼び出し / resolve

## 期待される動作

`joiningFetchInProgress` の解除はドレインループ末尾の 1 箇所 (`useSubscriber.ts:587`) のみとする。`useSubscriber.ts:652` の早期解除を撤去する。

これにより:

- LARGEST_OBJECT あり: `sendJoiningFetch` が走り、その完了時に `onEnd` がドレインを起動してフラグを下ろす。
- LARGEST_OBJECT なし: `onEnd` が同期呼び出しされ、ドレインループは即座にバッファ (空または notifyAlias で積まれた分) を処理してフラグを下ろす。

どちらの経路でも `joiningFetchInProgress=true` の間は object コールバックがバッファに振り分け、ドレインループが順序保証付きで `handleObject` を呼ぶ。

## 優先度

中。LARGEST_OBJECT なしのケース自体が draft-17 では想定外 (INVALID_RANGE が正規) のため発生確率は低いが、Publisher 実装の不整合で発生し得る。発生時はキーフレームロスト → デコードエラー連鎖 → 再生不能となるためユーザー影響は大きい。

## 解決方法

`devtools/src/hooks/useSubscriber.ts` の `await session.subscribe()` 直後にあった LARGEST_OBJECT なし時の早期 `joiningFetchInProgress: false` 解除を撤去した。

- LARGEST_OBJECT あり: `sendJoiningFetch` の完了で `onEnd` が呼ばれ、ドレインループ末尾 (`useSubscriber.ts:562` 付近) でフラグを下ろす。
- LARGEST_OBJECT なし: `src/session.ts:2989` で `onEnd` が同期呼び出しされ、ドレインループが空または既到着分のバッファを処理してから同じ位置でフラグを下ろす。

これにより `joiningFetchInProgress` の遷移点が単一になり、ドレインループ実行中に到着するライブオブジェクトが直接 `handleObject` 経路へ漏れる race を排除した。撤去箇所のコメントで draft-17 挙動と単一遷移点の意図を明示した。`vp run typecheck` / `vp run lint` / `vp run test` / `vp run build` / `vp run build:devtools` で全て成功することを確認した。
