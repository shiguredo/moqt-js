# 購読の Subgroup stream が reset されたときの error code を捨て、Object の欠落が relay のどの経路によるか分からない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-subgroup-reset-error-code
- Polished: {YYYY-MM-DD}

## 目的

配備 relay で、購読の Group の後半が届かず、次の Group の先頭まで表示が止まる事象が続いている (sora-moq で調査中)。2026-09-25 の計測では、5 回の購読で 1 回ずつ、subscriber が data stream の reset を受けた直後に Group の後半が欠けた (`subgroupStreamResets` が 1、止まりの原因が `loss`)。

relay は reset の理由ごとに異なる error code を使う (moqt-draft-21 Section 12.5)。たとえば期限切れは DELIVERY_TIMEOUT (0x2)、停滞の打ち切りは TOO_FAR_BEHIND (0x5)、cache の上限による打ち切りは INTERNAL_ERROR (0x0) で、上流の reset を伝えるときは publisher の code をそのまま使う。subscriber が受けた code を出せば、relay のログを読めない利用者も欠落の経路を絞れる。moqt-js は reset を受けたことだけを知らせ、code を捨てている。

また moqt-devtools の直近の止まり (`recentStalls`) は直近 30 回までで、到着の遅れによる止まりが多いと、欠落 (`loss`) の止まりが先に押し出される (2026-09-25 の計測で 1 回起きた)。欠落と reset は止まりとは別に、時刻つきで残す。

## 現状

- `src/session/publicTypes.ts` の `SubgroupStreamEnd` は `groupId` / `subgroupId` / `reason` (`"fin"` / `"reset"`) だけを持つ
- `src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` は、read の失敗がピアの RESET_STREAM (`isPeerStreamError`) なら `dataStreamNotifySubgroupEnd(..., "reset")` を呼ぶ。失敗値 (WebTransportError) の `streamErrorCode` は読まない
- `src/error.ts` には受信した code を正規化する `normalizeDataStreamErrorCode` があり (未知の code は INTERNAL_ERROR として扱う、Section 13)、bidi stream の reset (`createResetStreamError`) では使っている
- `devtools/src/hooks/useSubscriber.ts` は `subgroupEnd` の reset を数え (`subgroupStreamResets`)、`[id] subgroup stream reset` を Group ID / Subgroup ID つきでログに出すが、code は出さない
- `devtools/src/utils/playbackTimingStats.ts` の `recentStalls` は直近 30 回 (`MAX_RECENT_STALLS`) の止まりだけを持つ

## 設計方針

- `SubgroupStreamEnd` に `errorCode?: DataStreamErrorCode` を足す。reset で終わり、失敗値が数値の `streamErrorCode` を持つときだけ、`normalizeDataStreamErrorCode` で正規化した値を載せる。FIN で終わったときと、code を取れないときは載せない
- moqt-devtools は reset を code ごとに数えて出し (`window.moqtDevTools.getSubscribers()` と画面)、ログにも code の名前と値を出す
- 欠落の止まり (`loss`) と reset を、止まりの一覧とは別に、直近の一定数を時刻 (UTC) つきで残す。到着の遅れの止まりに押し出されないようにする

## 完了条件

- RESET_STREAM の code が `SubgroupStreamEnd.errorCode` に載ること (既知の code、未知の code は INTERNAL_ERROR、code の無い失敗値では載らない、FIN では載らない) を単体テストで固定する
- moqt-devtools で、reset の code ごとの数とログを単体テストで固定する
- 欠落と reset の一覧が止まりの一覧とは別に残ることを単体テストで固定する
- `vp check` と全テスト (vitest) が通る
