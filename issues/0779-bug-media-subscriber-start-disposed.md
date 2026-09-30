# MediaSubscriber の start がピア起点 close の解放中でも開始でき、資源の解放経路が消える

- Created: 2026-09-29
- Completed: 2026-09-29
- Branch: feature/fix-media-subscriber-start-disposed
- Polished: 2026-09-29

## 目的

`src/createMediaSubscriber.ts` の `start()` の入口検査は `closing` だけを見ており、ピア起点の close の解放 (`disposalInFlight`) が進行中でも開始を受け付ける。解放 D1 が `start()` の完了後に終端 (`"closed"`) へ進むと、開始した購読・デコーダー・出力・session が生きたまま残り、`close()` は早期 return、`stop()` と `start()` は state で拒否されるため解放経路が消える。0681 で publisher 側の同じ穴を修正した際に、レビューで subscriber 側に同型の穴が残っていることが判明した。

## 現状

- `src/createMediaSubscriber.ts` の `start()` の入口検査は `this.closing !== null` のみで `cannot start while closing` を投げる。`disposalInFlight` は見ていない
- 解放の調停 (`runDisposal` / `userDisposalCount` / `sessionGeneration` / `handleSessionClose`) は publisher と同一の機構で実装されている
- 再現の順序: (1) `start` #1 の実行中にピア起点の close が届き、解放 D1 が進行中になる (世代が進む)。(2) `start` #1 は段階の検査で中止し、巻き戻し D2 が D1 を待たずに完了して失敗が確定する (state は開始前の値に戻る)。(3) 利用者が `start` #1 の reject を待ってから直列に `start` #2 を呼ぶ。入口検査は `closing` だけなので通過し、捕捉する世代番号は D1 が進めた現在値と一致するため段階の検査もすべて通過し `"active"` になる。(4) D1 が完了して終端遷移が走り、state が `"closed"` と `onClose` になるが、`start` #2 が作った購読・デコーダー・出力・session は生きたまま残る
- `src/createMediaPublisher.ts` は 0681 で `disposalInFlight` の入口検査を追加済みである (`if (this.disposalInFlight !== null) { throw new Error("cannot start while closing"); }`)

## 設計方針

- publisher 側 (0681) と同じ形にする。`start()` の入口で `closing` に加えて `disposalInFlight` も見て、進行中なら `cannot start while closing` で拒否する
- 拒否は同期 throw とし、`onError` は通知しない (publisher 側と同じ)
- 既存の state ガード (終端 `"closed"` は `cannot start in state`) と、段階の await の直後の検査 (`assertStartNotDisposed`) は変えない。入口検査は、解放が `start()` の完了後に終端へ進む順序だけを塞ぐ
- 回帰テストは publisher 側の同名テストを subscriber 版に移植する。ピア起点の解放を保留し、`start` #1 が中止したあとに直列に `start` #2 を呼んで入口で拒否されること、解放の完了後に呼び直すと終端の state で拒否されることを固定する
- 対象は `src/createMediaSubscriber.ts` / `src/createMediaSubscriber.test.ts` / `CHANGES.md` とする

## 完了条件

- ピア起点の close の解放が進行中のまま `start()` を呼ぶと、入口で `cannot start while closing` により拒否される (`"publishing"` に到達しない)
- 解放の完了後に `start()` を呼ぶと、終端の state により拒否される
- 解放が進行していない正規の `start()` は拒否されない (stop → start の再開が従来どおり動く)
- `onError` は入口の拒否では通知されない (同期 throw のみ)
- `src/createMediaSubscriber.test.ts` に上記を固定するテストが追加され、入口検査を削ると落ちる
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- 0681 (publisher 側の同型の穴と修正。入口検査と回帰テストの出所)
- 0654 (subscriber 側の世代番号方式と調停の出所)
- `src/createMediaSubscriber.ts` の `start` / `runDisposal` / `handleSessionClose` / `assertStartNotDisposed`

## 解決方法

`src/createMediaSubscriber.ts` の `start()` の入口で、`closing` に加えて `disposalInFlight` も見るようにした。ピア起点の close の解放 (`disposalInFlight`) が進行している間は `cannot start while closing` で拒否する (入口で reject し、`onError` は通知しない)。進行中の解放が `start()` の完了後に終端へ進むと、開始した購読、デコーダー、出力、session を解放する経路が残らない (`close()` は早期 return し、`start()` と `stop()` は state で拒否される)。解放が完了したあとの呼び直しは、従来どおり終端の state で拒否される。

解放の全経路 (ピア起点の close、利用者の `stop()` / `close()`、`start()` 失敗時の巻き戻し) を確認した。`disposalInFlight` を立てるのは `runDisposal()` だけで、`stop()` / `close()` / `handleSessionClose()` の 3 箇所が `await` より前に呼ぶため、解放が進行中に `start()` が入る窓はない。`start()` 失敗時の巻き戻しは `disposeAllResources()` を直接呼んでフラグを立てないため、再試行を誤って拒否しない。

テストは `src/createMediaSubscriber.test.ts` に 2 件追加した。ピア起点の close の解放を保留して `start` #1 を中止させ、直列に呼んだ `start` #2 が入口で拒否されること (接続も購読も試みない)、解放の完了後に呼び直すと終端の state で拒否されること、`onError` が増えないことを固定する。あわせて、`stop()` の解放が終わったあとの再開が入口の拒否を受けないこと (誤拒否しないこと) を固定した。入口検査を削るとテストが落ちることを実測している。

`src/codec/types.ts` の `MediaSubscriber.start` の JSDoc と `docs/HIGH_LEVEL_API.md` のメソッド表を、解放が進行している間は拒否する契約に更新した。`CHANGES.md` の `## develop` の FIX 群先頭に `[FIX]` を追記した。

`npx vp check` と `npx vp test --run` (3460 テスト) が通る。
