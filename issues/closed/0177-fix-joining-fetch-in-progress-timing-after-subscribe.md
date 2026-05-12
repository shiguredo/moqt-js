# `joiningFetchInProgress` の立て位置を見直す (subscribe 完了後への単純な移動は不可)

Created: 2026-05-11
Completed: 2026-05-12
Model: Opus 4.7

## 解決方法

issue #0164 / #0171 のマージにより本 issue の修正対象が実体ごと消滅したため
close する。

- #0164 で `joiningFetchInProgress` は `SubscriberInstance` の Signal から
  `useSubscriber` フックローカルの `useRef<boolean>` に降格した。これにより
  本 issue が問題視していた「Signal の reactive 通知が SUBSCRIBE_OK 前に
  立っていることの意味論的ずれ」は外部観測者から見えなくなり、修正対象
  そのものが無くなった
- #0171 で導入された `resetSubscriberState` 内で
  `joiningFetchInProgressRef.current = false` が確実に走るため、
  `subscribe(...)` reject 時の catch 経路 (`teardownSubscriber()` 呼び出し)
  でも ref は false に戻る。本 issue が懸念した「立て位置のずれ」によるバグ
  経路は形成されない
- フックローカル ref への代入順序は `useSubscriber.ts` のローカルな同期
  セクション内に閉じており、Signal 時代のような外部観測者に対する意味論
  ずれは存在しない

将来 `joiningFetchInProgress` を再度 signal 化するなど状況が変わった場合は
別 issue を新規に起票する。

## 概要

`devtools/src/hooks/useSubscriber.ts` の `startSubscribing` 内で `instance.joiningFetchInProgress.value = joiningFetchEnabled` を `session.subscribe(...)` 呼び出しの **前** に立てている (`resetSubscriberStats` 内、L82)。本来 Joining Fetch は SUBSCRIBE_OK 受信後に moqt-js 内部で送信される処理であり、SUBSCRIBE_OK 前の Catalog 取得や `DecoderWrapper.configure` の await 中も `joiningFetchInProgress` が `true` になっているのは意味論的にずれている。

`joiningFetchInProgress` の用途は `object:` コールバックの「ライブ object を `liveObjectBuffer` に積むかどうか」のゲート判定のみで、UI への直接バインドはない (grep 確認済み)。現状の立て位置で機能的な不具合は発生していない (catch → `cleanupSubscriber` で false に戻り、`liveObjectBuffer` も空のままなので実害はない)。本 issue は **設計クリンナップ** の位置づけ。

## 実装着手 / pending 化の判断

本 issue は **0164 完了後の再評価をもって実装着手 / pending 化を判断する**。具体的には:

- 0164 (`joiningFetchInProgress` を Signal から フックローカル `useRef<boolean>` へ降格) が先行マージされると、`joiningFetchInProgress` は reactive 通知を起こさない単純な ref になる
- その時点で本 issue の修正対象は「フックローカル ref の代入順序」のみに縮小する
- 0164 適用後の `startSubscribing` 中で `subscribe(...)` reject 時に ref が常に false に戻る経路 (`cleanupSubscriber` (0171 後は `resetSubscriberState`) 内の `joiningFetchInProgressRef.current = false`) が機能しているかを実コードで確認し:
  - 機能していれば本 issue を `issues/pending/` に移し、pending 理由として「0164 で実体が消滅した」と記載
  - 機能していなければ本 issue を実装着手する (`subscribe(...)` 直前で true、reject 経路で false の明示)

着手判断者は 0164 マージ後の `useSubscriber.ts` を確認したうえで上記の二択を選ぶ。

## 関連 issue

- `issues/closed/0157-fix-joining-fetch-onend-drain-race.md`: `joiningFetch.onEnd` 内ドレインと立て下げの race を `batch()` + chainRef でアトミック化
- `issues/closed/0158-fix-joining-fetch-onerror-preserve-live-buffer.md`: `joiningFetch.onError` でもライブバッファを保持・ドレインする方針へ統一
- `issues/0164-refactor-subscriber-instance-signal-granularity.md`: `joiningFetchInProgress` を Signal → useRef へ降格。**本 issue は 0164 完了後に再評価する**
- `issues/0166-perf-live-object-buffer-use-ref.md`: `liveObjectBuffer` を Signal → useRef へ降格。`joiningFetch.onEnd` / `onError` のドレイン処理に影響するが、本 issue の修正対象 (`joiningFetchInProgress` の立て位置) とは直交

## 根拠 (実コードでの確認)

### moqt-js: `Session.subscribe` の resolve タイミング

`src/session.ts` の `Session.subscribe`:

- pending エントリを登録した後、`void readSubscribeResponse(...)` を起動して return

`src/session/bidi.ts` の `bidiReadSubscribeResponse` が SUBSCRIBE_OK を受け取ったときの同期処理順:

1. `session.subscribers.set` / `session.subscribersByAlias.set` で subscriber を登録
2. `session.pendingSubgroupBuffer.notifyAlias(...)` で pending subgroup buffer に積まれていた entry を起動する
3. `pending.joiningFetch` があれば `bidiSendJoiningFetch(...)` を fire-and-forget
4. `pending.resolve(pending.impl)` で `session.subscribe()` の Promise を解決
5. `void bidiReadRequestStreamMessages(...)` でストリーム本体の読み取り開始

### subgroup ストリーム経路の race

SUBSCRIBE_OK 同期処理 1 回の中で、`notifyAlias` (entry.notified Promise の resolve) と `pending.resolve` の 2 つが連続で実行される。両者は microtask キューに登録されるが、発火順は登録順。`notifyAlias` の方が `pending.resolve` より前に発火するため、`handleSubgroupStream` の race 後段が `startSubscribing` の subscribe `await` 継続より先に再開し、SubscriberImpl の `object:` コールバック (= devtools の `joiningFetchInProgress.value === true` で `liveObjectBuffer` に積む箇所) が **subscribe Promise 解決前に発火しうる**。

datagram 経路 (`handleIncomingDatagram`) は `subscribersByAlias.get(...)` が undefined ならその場で drop するため上記 race を構成しない。datagram の race は別 macrotask での到着に依存し、本 issue の対象外。

## 現状の立て位置で守られている不変条件

`joiningFetchInProgress` を `session.subscribe(...)` の **前** に立てているおかげで、subscribe 解決前にライブ object が届いても `object:` コールバックが `joiningFetchInProgress.value === true` を読み、`liveObjectBuffer` に積む。その後 `joiningFetch.onEnd` / `onError` のドレインで chainRef 経由に流れる。

立て位置を `await session.subscribe(...)` の **後** に移すと、上記 race window に入り込んだライブ object は `joiningFetchInProgress.value === false` を読んで `chainRef.current.then(handleObject)` に直接流れる。すると `joiningFetch.onEnd` 時の `joiningFetchLastLocation` ベースの重複除去で「ライブ初期 object が Joining Fetch 範囲と重複している」状態を検出する前に handleObject が走り、デコーダに非 keyframe を投入して decode error の引き金になる。

**したがって「subscribe 解決後に立てる」単純移動は不可。**

## 修正方針 (pending 化しない場合)

`subscribe(...)` 直前まで `joiningFetchInProgress` の true 化を遅延させ、reject 経路で確実に false に戻す。

1. `resetSubscriberStats` から `joiningFetchInProgress` の代入を削除する (0164 で同じ整理を行うため、0164 完了前にこの処理を行う場合は 0164 と差分が重複する。0164 完了後なら本処理は不要)
2. `await session.subscribe(...)` 呼び出しの **直前** (`subscribeOptions` 構築完了後の同期セクション末尾) に `instance.joiningFetchInProgress.value = joiningFetchEnabled;` (0164 適用後は `joiningFetchInProgressRef.current = joiningFetchEnabled;`) を移動する
3. `await session.subscribe(...)` の reject 経路を以下で明示的に false 化する:
   ```ts
   try {
     subscriberInstance = await session.subscribe(...);
   } catch (error) {
     instance.joiningFetchInProgress.value = false; // 0164 適用後は ref.current
     throw error;
   }
   ```
   `cleanupSubscriber` (0171 後は `resetSubscriberState`) で同じ false 化が走るため二重実行になるが、リセットは冪等で問題ない。

`joiningFetch.onEnd` / `onError` 内のドレイン処理は本 issue では触らない (現状維持)。

別 signal `joiningFetchPending` を導入する案は過剰なため採用しない。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts:resetSubscriberStats` / `startSubscribing`
- `joiningFetch.onEnd` / `onError` 内のドレイン処理は変更しない (現状維持)

## テスト戦略

- `vp run test` で全テストパス
- `subscribe(...)` 失敗時に `joiningFetchInProgress` が catch 完了時点で false になっていることを確認するテストを追加。具体的には `useSubscriber.test.ts` で `session.subscribe` の偽実装 (reject する Promise を返す) を呼ぶ純粋関数を切り出してテスト可能か検証する。フックを直接テストする仕組みが本リポジトリに無い場合は手動確認で代替する
- 「subscribe 解決前にライブ object が届いても `liveObjectBuffer` に積まれる」を再現するテストは偽 session でストリーム到着と SUBSCRIBE_OK 到着の順序制御が必要で、コストが高い。本 issue では追加せず、`pendingSubgroupBuffer` 周りの既存テストで間接担保する
- 手動確認:
  - Joining Fetch 有効で接続失敗 (URL 不正等) → `joiningFetchInProgress` が catch 完了後に false になっていることを Preact DevTools で確認
  - Joining Fetch 有効で正常接続 → 従来どおりライブバッファに積み・ドレインされる挙動を維持

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する。CLAUDE.md で `[FIX]` は「バグ修正」と定義されており、本 issue は機能的なバグ修正ではなく設計クリンナップ (起票者自身が概要セクションで「実害なし」を明言) のため `[UPDATE]` が妥当。

エントリ例:

```
- [UPDATE] devtools の `joiningFetchInProgress` の立て位置を `subscribe(...)` 直前へ移動し、reject 時の false 化を明示する (#0177)
  - @voluntas
```

## ブランチ命名

`feature/fix-` を使う (設計クリンナップだが修正としての性質を持つ)。

## 完了条件

- `resetSubscriberStats` から `joiningFetchInProgress` の代入が削除されている (または 0164 完了時点で削除済み)
- `joiningFetchInProgress` の true 化が `subscribe(...)` 呼び出し直前の同期セクションで行われる
- `subscribe(...)` の reject 経路で `joiningFetchInProgress = false` が明示されている
- `vp run test` 全パス
- `vp run build:devtools` でビルド成功
- 手動確認 (上記 2 項目) が通過
- 0164 完了後に本 issue を再評価し、実装着手 / pending 化を判断する。pending 化する場合は `issues/pending/` に移し pending 理由を本 issue 末尾に追記する
