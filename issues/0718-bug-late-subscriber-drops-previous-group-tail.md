# 別の stream で届いた前の Group の Object が次の Group の先頭より後にアプリへ渡り、moqt-devtools が前の Group の末尾を stale として捨てる

- Created: 2026-09-25
- Completed: 2026-09-25
- Branch: feature/fix-late-subscriber-drops-previous-group-tail
- Polished: {YYYY-MM-DD}

## 目的

Group の終わり近くで後から購読すると、moqt-devtools が前の Group の最後の delta を「復号中の Group より古い Object」(`staleFramesDropped`) として捨て、その Group の末尾のフレームが表示されない。sora-moq の E2E (`e2e-test/browser/relay_interop/test_moqtjs_network.py` の `test_late_subscriber_receives_groups_in_order_over_delay`、遅延 18 ms の経路で Group の 48 から 55 フレーム目に後から購読し、`staleFramesDropped` が 0 であることを確かめる) が約 20% (44 回中 9 回) 失敗する。

実測 (2026-09-25、手元 relay + 片道 18 ms の遅延 proxy + dev サーバーの devtools、Group の 49 フレーム目で後から購読):

- 10 回中 2 回、次の Group のキーフレームが前の Group の最後の delta より 0.3 ms 先にアプリへ渡った。購読直後の cache からの追い上げで 7 Object が約 7 ms の間にまとまって届いていた
- Chrome の NetLog では、後から購読した側の接続は前の Group の stream を FIN まですべて受けた後に次の Group の stream の最初のデータを受けている。relay は Group の順に送っている
- 本番ビルドの devtools では 28 回中 0 回だった

順序が崩れるのはブラウザ側である。moqt-js は stream ごとの非同期の読み取りループで Object をアプリへ渡すため、複数の stream のデータが同時に読める状態になると、アプリへ渡る順は読み取りの Promise が解決する順で決まり、ネットワークで届いた順とは限らない。draft-ietf-moq-transport-21 Section 2.1 は「Objects can be delivered out of order」とし、Group ごとに別の stream で届くため、前の Group の Object が次の Group の Object より後に届くことはプロトコルとしても起こりうる (経路での並び替えや再送)。

devtools と `createMediaSubscriber` は、復号中の Group より古い Group の Object を捨てる (`src/videoDecodeOrder.ts` の `VideoDecodeOrder`)。次の Group のキーフレームを復号した後に前の Group の delta を復号すると参照フレームが壊れるためであり、これ自体は正しい。問題は、前の Group の Object がまだ届く見込みがあるのに、次の Group のキーフレームを先に復号してしまうことである。

## 現状

- `src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` は Subgroup の stream ごとに読み取りループを持ち、Object を `SubscriberImpl.handleObject` 経由でアプリへ渡す。stream の終わり (FIN / RESET_STREAM) はアプリへ知らせない
- `src/session/publicTypes.ts` の `SubscribeCallbacks` に stream の終わりを受ける callback は無い
- `devtools/src/hooks/useSubscriber.ts` の `handleObject` と `src/createMediaSubscriber.ts` の映像の受信は、届いた順に `VideoDecodeOrder.admit` へ渡す

## 設計方針

- `SubscribeCallbacks` に Subgroup の stream の終わりを受ける `subgroupEnd` を足す。Group ID、確定した Subgroup ID、終わり方 (FIN / RESET_STREAM) を渡す
- 受信側 (devtools と `createMediaSubscriber` の映像) は、次の Group の Object が届いたとき、前の Group の stream がまだ終わっていなければ、次の Group の Object を保留する。前の Group の stream がすべて終わるか、保留の上限の時間を過ぎたら、保留した Object を届いた順に渡す。保留の間に届いた前の Group の Object は先に渡す
- 保留は前の Group の stream が実際に開いている間だけ行う。前の Group の stream が先に終わっていれば保留しない (前の stream を FIN してから次の stream を開く publisher では、保留は FIN の処理を待つ数 ms 以内で終わる)
- 保留の上限は、前の Group の stream を長く開いたままにする publisher で Group の切り替えごとに遅れ続けないよう短くする。値と根拠をコメントに書く
- 保留と解放の判定は純粋なモジュールに切り出し、単体テストと PBT で固定する

## 完了条件

- stream の終わり (FIN / RESET_STREAM) で `subgroupEnd` が呼ばれることを実ストリームのテストで固定する
- 保留の判定 (前の Group の stream が開いている間だけ保留する、終わったら解放する、上限で解放する、保留中に届いた前の Group の Object を先に渡す、並べ替えない) を単体テストと PBT で固定する
- sora-moq の `test_moqtjs_network.py::test_late_subscriber_receives_groups_in_order_over_delay` を dev サーバーの devtools で 20 回流して 0 回失敗になる。修正前の失敗率も同じ回数で測る
- `vp check` と全テストが通る

## 解決方法

保留の方法には、(a) 次の Group の Object を届いてから一定時間だけ保留する方法と、(b) 前の Group の stream の終わりを知らせて、それまで保留する方法がある。(a) は Group の切り替えごとに必ず一定時間遅れる。(b) は前の Group の stream が実際に開いている間だけ待ち、前の stream を FIN してから次の stream を開く publisher では待ちが FIN の処理までの数 ms 以内で終わるため、(b) にした。

- `SubscribeCallbacks.subgroupEnd` と `SubgroupStreamEnd` (Group ID、確定した Subgroup ID、`"fin"` / `"reset"`) を足した。`src/session/dataStreamIncoming.ts` の `dataStreamHandleSubgroupStream` が、FIN で終わったとき (未完成 Object を残さない場合、`dataStreamFinishSubgroupStream`) と RESET_STREAM で終わったときに、その stream の最後の Object を渡した後で `SubscriberImpl.handleSubgroupEnd` を呼ぶ (`dataStreamNotifySubgroupEnd`)。購読の終了や打ち切り (Malformed Track、バッファ上限) では呼ばない。SUBSCRIBE と受信 PUBLISH の両経路で、goaway / fillError / subgroupEnd の代入を `SubscriberImpl.setSessionCallbacks` にまとめた
- `src/groupSwitchGate.ts` に `GroupSwitchGate` を足した。次の Group の Object が届いたとき、渡した Group からその前までの Group に開いている Subgroup の stream があれば Group ごとに保留し、前の Group の stream がすべて終わるか保留の上限 (`GROUP_SWITCH_HOLD_MS` = 50 ms) を過ぎたら、Group の古い順に (同じ Group の中では届いた順に) 渡す。渡した Group 以前の Object はそのまま渡す。Subgroup ID を持たない Object (Datagram) は開いている stream として数えない。まだ Object が届いていない stream は見えないため、Group ID の飛びでは保留しない
- `createMediaSubscriber` の映像の購読と moqt-devtools の `useSubscriber` は、object コールバックと subgroupEnd コールバックを `GroupSwitchGate` に通し、保留が残っていれば上限の時刻にタイマーで保留を解く。購読の開始と停止 (close) で保留を捨てる
- テスト: FIN / RESET_STREAM で最後の Object の後に subgroupEnd が呼ばれること (`src/session.test.ts`)、保留と解放の規則 (`src/groupSwitchGate.test.ts`)、stream の順序を保って到着順を入れ替えた列で各 Object をちょうど 1 回、Group の中では届いた順に渡すこと、stream が Group の順に始まる列では渡す Group が減らないこと (`src/groupSwitchGate.prop.ts`)、`createMediaSubscriber` が前の Group の末尾を先に復号して stale を出さないことと上限で保留を解くこと (`src/createMediaSubscriber.test.ts`)
- `vp check` と全テスト (134 ファイル / 2688 件) が通った

sora-moq の `test_moqtjs_network.py::test_late_subscriber_receives_groups_in_order_over_delay` を 20 回ずつ流した (2026-09-25、relay は同じビルドを ebin の写しで固定し、devtools は各 commit の git worktree の dev サーバー)。

- 修正前 (1ea483d): 20 回中 3 回失敗。3 回とも後から購読した側の `staleFramesDropped` が 0 でない
- 修正後 (65bd6a7): 20 回中 0 回失敗
