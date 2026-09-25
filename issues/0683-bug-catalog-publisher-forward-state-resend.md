# Catalog Publisher が Forward State 変化で catalog を送り直さない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-publisher-forward-state-resend
- Polished: 2026-09-24

## 目的

`src/createMediaPublisher.ts` は catalog を `start()` のたびに 1 回だけ送る。音声は Forward State の変化で Audio Config を送り直す経路を持つが、catalog Publisher には Forward State の変化コールバックが登録されておらず、購読者が後から接続しても catalog が送り直されない。

draft-ietf-moq-transport-21 §3.1 は「Established な購読には Forward State 0 か 1 があり、publisher は 0 の間 Object を送らず 1 の間は送る」と定める。relay は購読者が居ない間 FORWARD=0 を伝えるため、配信開始時に送った catalog は後着の購読者へ届かない。購読側は catalog から映像・音声トラックの構成を知るため、catalog が届かないとトラックの購読に進めない。

購読側 (`src/createMediaSubscriber.ts`) は catalog を SUBSCRIBE と FETCH の両方で取りに行くが、FETCH は relay が保持している範囲しか返せず、SUBSCRIBE は Next Object で張るため購読開始より前に送られた catalog は届かない。devtools は同じ問題を closed/0624 で直しており (`onForwardStateChange` で新しい Group として catalog を送り直す)、ライブラリ側にはこの経路が無い。

## 現状

- `src/createMediaPublisher.ts` の `createPublishers` (605-652 行目) は catalog Publisher を 612-623 行目で作り、`error` コールバックだけを渡す。Forward State 変化のコールバックは登録しない
- `src/createMediaPublisher.ts` の `publishCatalog` (664-692 行目) は `createPublishers` から 1 回だけ呼ばれ (651 行目)、686-691 行目で `groupId: 0` / `objectId: 0` 固定の Object を 1 件送って return する。再送する経路は無い
- `src/createMediaPublisher.ts` の `currentCatalog` (376-377 行目) は `publishCatalog` が組み立てた catalog を保持する (675 行目) が、`getCatalog` (572-574 行目) 以外からは読まれず、送り直しには使われていない
- `src/session/requests.ts` の `requestsPublish` (123 行目) は 170 行目で `impl.setForwardState(options?.forward ?? true)` を呼ぶ。高レベル API は `forward` を渡さないため catalog Publisher の初期 Forward State は 1 であり、配信開始時の catalog は Forward State 1 で送られる。そのあと relay が `REQUEST_UPDATE (FORWARD=0)` を送ると 0 になり、`src/publisher.ts` の `PublisherImpl.guardSend` (518-530 行目) が `"skip"` を返し、`sendObject` (569-576 行目) は送信せず解決する
- `src/publisher.ts` の `PublisherImpl.setForwardState` (755-760 行目) は状態が変化したときだけ `forwardStateChangeCallback` を呼ぶ。受信 PUBLISH 経路では `src/session/incomingPublish.ts` の `applyPublishRequestUpdate` が 1017 行目で `setForwardState` を呼ぶ
- `src/createMediaSubscriber.ts` の `subscribeCatalog` (604-720 行目) は catalog トラックを 641-669 行目で `filter: { startGroup: 0n, startObject: 0n }` (Next Object) 付きで SUBSCRIBE し、680-700 行目で `catalogFetchFilter` (143-154 行目) による FETCH を投げる。SUBSCRIBE の Forward State は既定 1 であり、relay は downstream の購読者が Forward State 1 になると publisher へ `REQUEST_UPDATE` を送る MUST がある (draft-ietf-moq-transport-21 §7.5)
- `devtools/src/hooks/usePublisher.ts` は 0624 以降、catalog Publisher の `onForwardStateChange` (789-793 行目) から `sendCatalogUpdate` (693-714 行目) を呼び、`catalogGroup` を +1 した新しい Group で Object ID 0 の catalog を送り直す。開始時の Group ID も `Date.now()` で決めている (847 行目)
- draft-ietf-moq-msf-01 §5 は「catalog の更新はすべて MOQT sub-group 0 に置く」「catalog トラックのどの Group でも最初の Object (Object ID 0) は独立した catalog の完全なコピーでなければならない」「独立した更新が生じたら新しい Group の先頭に置く」と定める。現在の固定 `groupId: 0` は送り直しのたびに同じ Location を送ることになるため、そのままでは再送できない
- `src/createMediaPublisher.ts` の `disposeAllResources` (1036-1108 行目) は catalog Publisher を 1069-1075 行目で `done()` して参照を切る。catalog の Group ID を保持するフィールドは無い
- 0679 は `publishCatalog` の await 経路で送信 reject が二重に通知される件であり、Forward State による送り直しの有無は扱っていない

## 設計方針

- catalog Publisher の作成時に `onForwardStateChange` を登録し、Forward State が 0 から 1 になった時点で catalog を送り直す
- 送り直しは新しい Group で行う。送信済み catalog Group ID を `MediaPublisherImpl` のフィールドで保持し、送り直しのたびに +1 する。Object ID は Group の先頭 Object なので 0 にする (draft-ietf-moq-msf-01 §5)
- 開始時の catalog Group ID は `createInitialGroupId` (`src/msf/tracks.ts` 121 行目) を `allocateInitialGroupId` (`src/createMediaPublisher.ts` 83-90 行目) 経由で払い出し、`createPublishers` のたびに新しい値を取る。映像・音声と同じ規則に揃えることで、`stop()` → `start()` を跨いでも Group ID が単調増加になる (draft-ietf-moq-msf-01 §6.1 の MUST)。現在の固定値 0 は再 start のたびに 0 に戻る
- `publishCatalog` を「catalog を組み立てて `currentCatalog` に保持する」処理と「新しい Group で送る」処理に分け、Forward State の変化からは後者だけを呼ぶ。送り直しのたびに catalog を再生成しない (トラック構成が変わらない限り同じ payload を使う)
- Forward State の変化コールバックは同期であるため送信は `void` で起動する。失敗を握り潰さず `this.callbacks.onError` に流す (0679 が扱う reject の二重通知とは別の経路であることをコメントに書く)
- catalog Publisher が `"active"` でない場合は送らない。`publishCatalog` の既存ガード (665-667 行目) と同じ判定を使う
- Forward State が 1 のまま 2 人目以降の購読者が接続した場合は変化が起きないため送り直さない。この制約は音声の送り直しと同じであり、JSDoc に書く
- 対象は `src/createMediaPublisher.ts` / `src/createMediaPublisher.test.ts` / `docs/HIGH_LEVEL_API.md` / `CHANGES.md` とする
- テストは `src/createMediaPublisher.test.ts` の `createPublishRecordingSession` (1206-1226 行目) が記録する `callbacksByTrack` を使う。catalog Publisher のコールバックに Forward State 1 を与え、`catalogSent` に 2 件目が積まれ、Group ID が 1 件目より大きく、Object ID が 0 で、payload が `encodeCatalog` の出力と一致することを固定する
- 0681 (`disposeAllResources` の世代番号) と 0679 (`publishCatalog` の reject 通知) も `src/createMediaPublisher.ts` と `CHANGES.md` を対象にするため同時に進めない。0682 も同じファイルを対象にするため、0682 の完了後に着手する
- `CHANGES.md` の `## develop` の先頭に `[FIX]` を追記する (セクション内は新しい順)

## 完了条件

- catalog Publisher に `onForwardStateChange` が登録される
- Forward State が 0 から 1 になった時点で catalog が送り直される (2 件目が送られる)
- 送り直しの Group ID が直前の catalog の Group ID より大きい
- 送り直しの Object ID が 0 であり、payload が保持している catalog の `encodeCatalog` の出力と一致する
- Forward State が 1 から 0 に変わっただけでは送らない。1 → 0 → 1 では送る
- catalog Publisher が `"active"` でない場合は送らない
- `stop()` → `start()` のあとの catalog の Group ID が前回より大きい
- 配信開始時の catalog が Forward State 1 の状態で 1 件送られる既存の挙動が変わらない
- 送り直しの送信が reject した場合に `onError` が呼ばれる
- `src/createMediaPublisher.test.ts` に上記を固定するテストが追加される
- `docs/HIGH_LEVEL_API.md` に catalog の送り直し契約が書かれ、実装と一致する
- `CHANGES.md` の `## develop` の先頭に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §3.1 (Subscriptions。Forward State の定義) / §7.5 (Publisher Interactions。relay が Forward State を 1 に変える MUST) / §9.20.19 (FORWARD Parameter)
- draft-ietf-moq-msf-01 §5 (Catalog。sub-group 0 / Group の先頭 Object は独立した catalog / 新しい Group の先頭に置く / トラック構成が変わったときとキャッシュから落ちる程度の時間が経過したときに publish する SHOULD) / §6.1 (Group numbering。単調増加の MUST と再起動時の開始値) / §6.2 (Object Numbering。Group の先頭 Object ID は 0)
- closed/0624 (devtools の catalog 送り直し) / closed/0629 (音声の config 送り直し。実装の形の出所) / 0682 (映像の VIDEO_CONFIG の送り直し) / 0679 / 0681 (同じファイルを触る未着手 issue)
- `src/createMediaPublisher.ts` の `publishCatalog` / `createPublishers` / `disposeAllResources`、`src/session/requests.ts` の `requestsPublish`、`src/publisher.ts` の `setForwardState` / `guardSend`、`src/session/incomingPublish.ts` の `applyPublishRequestUpdate`、`src/createMediaSubscriber.ts` の `subscribeCatalog` / `catalogFetchFilter`、`devtools/src/hooks/usePublisher.ts` の `sendCatalogUpdate`

## 追記: MAX_CACHE_DURATION を過ぎた catalog の送り直し (2026-09-25)

devtools の publisher で、Forward State の変化による送り直しだけでは足りないことが分かった (0726)。relay が購読者の居ない間も Forward State を 1 に保つ場合 (sora-moq の prewarm) や、別の購読者が居続ける場合は Forward State が変わらず、catalog は送り直されない。draft-ietf-moq-transport-21 §10.3 により relay は MAX_CACHE_DURATION を過ぎた catalog を cache から配れないため、配信の開始から catalog の MAX_CACHE_DURATION を過ぎた後に購読を始めた相手は catalog を得られない。

`src/createMediaPublisher.ts` の catalog は MAX_CACHE_DURATION が 3600000 ms (1 時間) で、配信の開始時に 1 回だけ送る。同じ理由で、配信の開始から 1 時間を過ぎると後から購読を始めた相手は catalog を得られない。draft-ietf-moq-msf-01 §5.1 の「キャッシュから落ちる程度の時間が経過したときに publish する SHOULD」に当たる。

この issue で送り直しを入れるときは、Forward State の変化に加えて、catalog を送るたびに MAX_CACHE_DURATION の半分 (1 秒以上、30 秒以下) の後の送り直しを予約する。devtools は 0726 で `devtools/src/utils/catalogRepublish.ts` の `catalogRepublishIntervalMs` を使う形にした。ライブラリへ入れるときは、この関数を `src/` へ移して devtools からも使う。

完了条件に次を足す。

- catalog を送るたびに、MAX_CACHE_DURATION の半分 (1 秒以上、30 秒以下) の後に新しい Group で送り直す。`stop()` / `close()` で予約を取り消す

## 解決方法

{未着手}
