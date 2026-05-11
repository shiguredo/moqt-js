# `joiningFetchInProgress` の立て位置を見直す (subscribe 完了後への単純な移動は不可)

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts` の `startSubscribing` 内で
`instance.joiningFetchInProgress.value = joiningFetchEnabled` を `session.subscribe(...)`
呼び出しの **前** に立てている (`resetSubscriberStats` 内、L82)。
本来 Joining Fetch は SUBSCRIBE_OK 受信後に moqt-js 内部で送信される (`bidiSendJoiningFetch`)
処理であり、SUBSCRIBE_OK 前の Catalog 取得 (L259-358) や DecoderWrapper.configure (L388) の
await 中も `joiningFetchInProgress` が `true` になっているのは意味論的にずれている。

加えて、ライブ用 `session.subscribe` の `await` 中に reject されると、その間
`joiningFetchInProgress` が `true` のまま残る (catch → `cleanupSubscriber` で false 化されるため
最終的には false に戻り、`liveObjectBuffer` も空のままなので実害はないが、設計として不自然)。

`joiningFetchInProgress` の用途は `object:` コールバック (L539) の
「ライブ object を `liveObjectBuffer` に積むかどうか」のゲート判定のみで、UI への直接バインド
はない (`grep joiningFetchInProgress devtools/src` 確認済み)。よって本 issue は機能的なバグ修正
ではなく **設計クリンナップ** の位置づけになる。

直感的な対処は「`await session.subscribe(...)` の resolve 直後にフラグを立てる」だが、
moqt-js 側の SUBSCRIBE_OK 処理と subgroup ストリームの並行関係を実コードで追うと、
**この単純な移動はライブ初期 object を取りこぼす race を導入する**。本 issue では現状の
立て位置がなぜそうなっているかを根拠で固め、許容できる代替案のみを採用する。

## 関連 issue

- `issues/closed/0157-fix-joining-fetch-onend-drain-race.md`
  - `joiningFetch.onEnd` 内ドレインと立て下げの race を `batch()` + chainRef でアトミック化
- `issues/closed/0158-fix-joining-fetch-onerror-preserve-live-buffer.md`
  - `joiningFetch.onError` でもライブバッファを保持・ドレインする方針へ統一

## 根拠 (実コードでの確認)

### moqt-js: `Session.subscribe` の resolve タイミング

`src/session.ts` の `Session.subscribe` (L1138-1262):

- `pendingSubscribe.set(requestId, { resolve, reject, impl, joiningFetch, objectCallback })`
  で pending エントリを登録 (L1212-1220)
- SUBSCRIBE メッセージ送信後、`void readSubscribeResponse(...)` を起動して return (L1259-1261)

`src/session/bidi.ts` の `bidiReadSubscribeResponse` (L217-298) が SUBSCRIBE_OK を受け取った
ときの同期処理順:

1. `session.subscribers.set` / `session.subscribersByAlias.set` で subscriber を登録 (L258-259)
2. `session.pendingSubgroupBuffer.notifyAlias(decoded.trackAlias, "subscriber")` で
   pending subgroup buffer に積まれていた entry を起動する (L261)
3. `pending.joiningFetch` があれば `bidiSendJoiningFetch(...)` を fire-and-forget (L263-275)
4. `pending.resolve(pending.impl)` で `session.subscribe()` の Promise を解決 (L277)
5. `void bidiReadRequestStreamMessages(...)` で双方向ストリーム本体の読み取り開始 (L279)

### `notifyAlias` は entry.notified Promise を resolve する

`src/pendingSubgroupBuffer.ts:162-168` の `notifyAlias` は `entry.notify(reason)` を呼ぶだけで、
その先で `entry.notified` Promise が resolve される (microtask スケジューリング)。

### subgroup ストリーム側の待ち受け

`src/session.ts:3268-3348` の `handleSubgroupStream` は subscriber 未登録時に
`Promise.race([reader.read(), entry.notified])` で待っており、`notifyAlias` の通知を受けると
`subscribersByAlias.get(...)` で subscriber を取り直し、buffer を concat して通常 mode に合流して
`subscriber.handleObject(...)` 経路へ object を流す。

### race の構造

SUBSCRIBE_OK 同期処理 1 回の中で

- L261: `entry.notified` Promise を resolve (= microtask キューに後段処理を登録)
- L277: `pending.resolve(impl)` で subscribe Promise を resolve (= microtask キューに `await
  session.subscribe(...)` の継続を登録)

この 2 つは同一同期スコープで連続して resolve されるが、microtask の発火順は **キュー登録順**。
L261 の通知の方が L277 より前に発火するため、`handleSubgroupStream` の race 後段が
`startSubscribing` の subscribe `await` 継続より先に再開し、その先で
`subscriber.handleObject(object)` → SubscriberImpl の `object:` コールバック
(= devtools の `object: (obj) => { if (joiningFetchInProgress.value) buffer.push }`) が
**subscribe Promise 解決前に発火しうる**。

datagram 経路 (L2933-2952 周辺) も同様に subscriber 登録直後に `subscriber.handleObject(object)`
へ流れるため、同じ race を構成する。

## 現状の立て位置で守られている不変条件

`joiningFetchInProgress` を `session.subscribe(...)` の **前** に立てているおかげで、
subscribe 解決前にライブ object が届いても `object:` コールバック
(`devtools/src/hooks/useSubscriber.ts:537-549`) が
`joiningFetchInProgress.value === true` を読み、`liveObjectBuffer` に積む。
その後 `joiningFetch.onEnd` / `onError` のドレインで chainRef 経由に流れる。

立て位置を `await session.subscribe(...)` の **後** に移すと、上記 race window に
入り込んだライブ object は `joiningFetchInProgress.value === false` を読んで
`chainRef.current.then(handleObject)` に直接流れる。すると:

- `joiningFetch.onObject` が拾う過去オブジェクトと、ライブ初期 object の順序が
  保証されなくなる
- `joiningFetch.onEnd` 時の `joiningFetchLastLocation` ベースの重複除去で「ライブ初期 object が
  Joining Fetch 範囲と重複している」状態を検出する前に handleObject が走り、デコーダに
  非 keyframe を投入して decode error の引き金になる

## 修正方針

単純な「subscribe 解決後にフラグ」は採用しない。以下のいずれかで対称化する。

### 案 A (推奨): try/finally で「resolve 後の不要な true」を消す

`resetSubscriberStats` から `joiningFetchInProgress.value` の代入を外し、
`subscribeOptions` を組み立てる直前まで遅延させた上で、subscribe の reject に対しては
catch で確実に false に戻す。具体的には以下のいずれか:

1. `joiningFetch` を実際に subscribeOptions に積むタイミング (L414 周辺) で同期的に
   `instance.joiningFetchInProgress.value = true` を立てる。これは
   `await session.subscribe(...)` を呼ぶ直前の同期セクションで実行され、reject 時は
   `catch (error)` (L569) → `cleanupSubscriber()` (L644) で false に戻る。
   現状との差分は「`resetSubscriberStats` を呼んでから subscribeOptions 構築までの間」の
   true 持続時間がほぼ 0 になる点だけ。
2. それでも race を防げないため、`subscribe()` の reject パスを `try { await
   session.subscribe(...) } catch (error) { instance.joiningFetchInProgress.value = false;
   throw error }` で明示する。`cleanupSubscriber` 経由のリセットと二重になるが、リセットは
   冪等なので問題ない。

### 案 B: pending / cleanup 段階でも対称化する

`startSubscribing` 全体を `try { ... } catch (error) { joiningFetchInProgress.value = false; ... }`
で囲み、`resetSubscriberStats` の代入はそのまま残す。これは「現状ほぼそのまま、catch 経路の
明示的な false 化を追加」する保守的案。`cleanupSubscriber` が L644 で false 化している以上、
動作は変わらないが、可読性目的で書く価値はある。

### 案 C: 別 signal `joiningFetchPending` を導入

「subscribe 完了前に true、SUBSCRIBE_OK 受信後 onEnd / onError までも true、ドレイン完了で false」
の意味論を 1 つの signal に詰め込まず、`joiningFetchPending` (subscribe 進行中) と
`joiningFetchInProgress` (onEnd / onError 待ち) に分離する。`object:` コールバック側の
バッファ条件は `joiningFetchPending.value || joiningFetchInProgress.value` で OR。
拡張性は高いが、本 issue の目的 (微小な true 持続時間の解消) に対しては過剰。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts:resetSubscriberStats` / `startSubscribing`
- 案 C を選ぶ場合のみ `devtools/src/signals/subscriber.ts:SubscriberInstance` も変更

## テスト戦略

- `vp run test` で全テストがパスすること
- 新規テスト (case 1): subscribe 失敗時に `joiningFetchInProgress` が catch 完了時点で
  false になっていることを確認
- 新規テスト (case 2): subscribe 解決前に object コールバックが発火しても
  `liveObjectBuffer` に積まれることを偽 session で再現
  - これは現状動作の回帰テストとして残す価値がある

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `session.subscribe(...)` 失敗時に `joiningFetchInProgress` が catch を抜けた時点で false
- subscribe 解決前にライブ object が届いても、`joiningFetch` 有効時は引き続き
  `liveObjectBuffer` に積まれる (race を再現するテストで保証)
- `vp run test` が全パス

## 残懸念

- 上述の race を再現する単体テストを書くには偽 session でストリーム到着と SUBSCRIBE_OK 到着の
  順序を制御する必要があり、コストが高い。最低限「subscribe reject 時に false」のみの確認に
  留めるか、`pendingSubgroupBuffer` 周りの既存テストフィクスチャを活用するか別途検討する。
- 案 C を採用するなら別 issue として分離した方が良い。
- 機能的に何も困らない以上、本 issue を `issues/pending/` に倒して保留する選択肢もある。
  Catalog 取得を含む「subscribe 準備中」の意味論を `joiningFetchInProgress` から
  切り離したい設計欲求がはっきりした時点で再開する判断もありうる。
