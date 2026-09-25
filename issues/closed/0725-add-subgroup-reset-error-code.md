# 購読の Subgroup stream が reset されたときの error code を捨て、Object の欠落が relay のどの経路によるか分からない

- Created: 2026-09-25
- Completed: 2026-09-25
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

## 解決方法

- `src/error.ts` に `peerStreamErrorCode` を足した。read / write の失敗値の `streamErrorCode` が数値なら `normalizeDataStreamErrorCode` で正規化して返し (未知の code は INTERNAL_ERROR)、無ければ undefined を返す。bidi stream の reset (`createResetStreamErrorWithMessage`) も同じ関数を使うようにした
- `src/session/publicTypes.ts` の `SubgroupStreamEnd` に `errorCode?: DataStreamErrorCode` を足し、`src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` が RESET_STREAM で終わった stream の code を載せる。FIN と code の無い失敗値では載せない。`DataStreamErrorCode` を `src/index.ts` から公開した
- `devtools/src/utils/playbackTimingStats.ts` の `recordSubgroupEnd` が code と受け取った時刻を受け、reset を code ごとに数える (`subgroupStreamResetsByCode`、キーは `formatStreamResetCode` の「名前 (16 進の値)」、code が無ければ `no code`)。reset と欠落 (`loss`) の止まりは、止まりの一覧とは別の `recentLossEvents` (直近 30 件、`MAX_RECENT_LOSS_EVENTS`) に時刻順で残す。到着の遅れの止まりに押し出されない
- `devtools/src/hooks/useSubscriber.ts` は reset のデバッグログに code を出す。`SubscriberPanel` と `DebugPanel` の統計のテキストに、code ごとの数と `recentLossEvents` (UTC) を出す
- テスト: `peerStreamErrorCode` (既知 / 未知 / code 無し / 数値でない / object でない)、`SubgroupStreamEnd.errorCode` (0x0 / 0x1 / 0x2 / 0x5 / 未知の 0x99、FIN と code 無しでは載らない)、code ごとの数、`recentLossEvents` が止まりの一覧から押し出されても残ること、上限、1 行の文字列。`vp check` と全テスト (2743 件) が通った
- 手元の relay と Chromium で、publisher の stream を途中で reset して subscriber に code が届くことも確かめようとしたが、確かめられなかった。cache を持たない relay では、Chrome が RESET_STREAM を送らなかった (NetLog で確認)。cache を持つ relay でも同じく上流の stream は reset されずに開いたままで、relay は下流の stream を Track の終了のときに初めて reset した (上流が開いている間は下流も開いておくのが正しい。Track の終了のときは購読が先に閉じるため、通知されない)。実ブラウザでの code の値は、配備した devtools で reset が起きたときに確かめる
- 配備した devtools (2026-09-25) で配備 relay の購読を流したところ、Group の後半の欠落の 4 回すべてで、subscriber は数値の code 0 (`INTERNAL_ERROR (0x0)`) を受け取り、`subgroupStreamResetsByCode` と `recentLossEvents` に出た。Chrome が RESET_STREAM の code を `streamErrorCode` で渡すことを実ブラウザで確かめた
