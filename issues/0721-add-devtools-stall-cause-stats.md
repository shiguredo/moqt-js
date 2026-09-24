# moqt-devtools の subscriber が表示の止まりの原因を区別して出さず、受信側のかくつきが経路・relay・publisher・受信側のどれによるか分からない

- Created: 2026-09-25
- Completed: {YYYY-MM-DD}
- Branch: feature/add-devtools-stall-cause-stats
- Polished: {YYYY-MM-DD}

## 目的

配備環境の moqt-devtools で、受信側の映像がまだかくつく (2026-09-25、利用者の確認)。devtools は表示の止まりの回数と時間 (`displayStalls` / `displayStallMs`) を出すが、止まりごとの原因は出さない。原因の候補は次のとおりで、どれかによって直す場所が変わる。

- publisher がフレームを撮れていない (TIMESTAMP が飛ぶ)
- Object が届いていない (relay が stream を reset した、Group や Object が飛んだ)
- Object は届いたが復号せずに捨てた
- 到着が表示の時刻に間に合わなかった (経路の遅延の跳ね)
- 受信側の処理 (Group の切り替えの保留、復号、jitter buffer の再生遅延の増加、描画) が遅れた

累積のカウンタと分布だけでは、1 回の止まりがどの原因によるかを対応づけられない。止まりごとに原因を 1 つに決めて数え、直近の止まりを時刻つきで出す。時刻が分かれば、relay の reset のログ (理由つき) と突き合わせられる。

## 現状

- `devtools/src/utils/playbackTimingStats.ts` の `PlaybackTimingStats.recordDisplay` は、表示間隔がフレーム間隔の 1.5 倍を超えたら止まりとして数え、回数と時間だけを累積する。止まりの前後のフレームが、いつ届き、いつ復号され、いつ表示の時刻を迎えたかを見ない
- `devtools/src/hooks/useSubscriber.ts` は、捨てたフレームを理由ごとの累積 (`staleFramesDropped` / `missingReferenceFramesDropped` / `displayQueueDrops` / `lateFramesDropped`) で数えるだけで、どのフレームを捨てたかを残さない
- 購読の `subgroupEnd` コールバックは終わり方 (`fin` / `reset`) を受け取るが、Group の切り替えの保留 (`GroupSwitchGate`) に渡すだけで、reset を数えない
- 届いた Object の Group ID と Object ID の飛び (届かなかった Object) を数えない
- Group の切り替えの保留が上限 (50 ms) で解けた回数を数えない

## 設計方針

- 止まりの原因の判定はブラウザ API に依存しない純粋なモジュール (`devtools/src/utils/stallAnalysis.ts`) に置き、時刻は引数で受ける。フレームごとに、位置 (Group ID / Object ID)、受け取った時刻、保留を解いた時刻、復号の開始と出力の時刻、表示の時刻 (jitter buffer の表示時刻)、行き先 (表示 / 復号せずに捨てた / 表示に間に合わずに捨てた / キューのあふれで捨てた) を TIMESTAMP ごとに記録する
- `PlaybackTimingStats.recordDisplay` が止まりを数えるとき、同時に原因を 1 つ決める (止まりの回数と時間は、原因ごとの回数と時間の和に一致する)。原因は、前に表示したフレーム P の次に表示されるはずだったフレーム N (P より後で TIMESTAMP が最小のフレーム) の行方で決める
  - `loss`: P と N の位置が連続しない (Object ID / Group ID の飛び、Group の stream が FIN で終わっていない)。表示に必要な時点で、間の Object が届いていない
  - `source`: N が今回表示したフレームで、位置が連続し、TIMESTAMP の差がフレーム間隔の 1.5 倍を超える (publisher が撮れていない)
  - `discarded`: N は届いたが、Group の順序と欠落、decoder の未構成、復号の失敗で復号せずに捨てた
  - 以下は、N が表示の時刻 (jitter buffer の表示時刻、無ければ P の表示の時刻 + TIMESTAMP の差) に間に合わなかった段で決める
    - `arrival`: 受け取った時刻が表示の時刻から通常の復号時間を引いた時刻より後 (経路と relay の遅れ)
    - `groupSwitchHold`: 保留を解いた時刻が同じく間に合わない
    - `decode`: 復号の出力が表示の時刻より後
    - `playout`: 表示の時刻までに表示できる状態だったが、jitter buffer の表示時刻そのものが P の表示から止まりの閾値より後 (再生遅延の増加)
    - `render`: 表示できる状態で表示の時刻を迎えたが、描くのが遅れた (または間に合わずに捨てた)
  - 記録が残っていない (窓より古い) ときは `unknown`
- 受信の欠けを数える: 届かなかった Object (Group の中の Object ID の飛び。Prior Object ID Gap の分は除く)、届かなかった Group (Group ID の飛び)、RESET_STREAM で終わった Subgroup の stream、上限で解けた Group の切り替えの保留
- 直近 30 回の止まりを、壁時計の時刻、長さ、原因、表示したフレームの Group ID / Object ID とともに残す。止まりと stream の reset はデバッグログにも時刻つきで出す
- `SubscriberPanel` と `DebugPanel` に出し、`window.moqtDevTools.getSubscribers()` の `playbackTiming` に出す

## 完了条件

- 原因ごとの判定を合成した時系列の単体テストで固定する
- PBT で、原因ごとの回数と時間の和が `displayStalls` / `displayStallMs` に一致することを固定する
- 届かなかった Object / Group と reset の数え方を単体テストで固定する
- `vp check` と全テストが通る
- 配備した devtools で、配備 relay の購読の止まりが原因ごとに出ることを確かめる
