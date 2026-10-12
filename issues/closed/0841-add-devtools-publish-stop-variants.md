# moqt-devtools の publish 停止に、止め方のバリエーションを足す

- Created: 2026-10-12
- Completed: 2026-10-13
- Branch: feature/add-devtools-publish-stop-variants
- Polished: 2026-10-12
- Reporter: @voluntas

## 目的

moqt-devtools の Stop Publish は「各トラックに PUBLISH_DONE (TRACK_ENDED) を送ってから publisher のセッションを閉じる」の 1 通りしかない。publisher の止め方によって、購読者に届く終了通知は変わる (PUBLISH_DONE が届く場合と、何も届かず購読が残る場合があり、どちらになるかは止め方と relay の実装で決まる)。切り分けツールとして、これらの止め方を意図的に再現できるようにする。

## 現状

- `devtools/src/hooks/usePublisher.ts` の `stopPublishing` は、complete catalog を送ってから、catalog / 映像 / 音声 / event の publisher に対して `done()` を呼び、`cleanupPublisher` で `pubSession` を閉じる。`src/publisher.ts` の `done()` は PUBLISH_DONE (TRACK_ENDED) を送る
- PUBLISH_DONE を送らずにセッションだけを閉じる経路と、何も送らずに配信だけを止める経路は、UI から再現できない
- セッションを閉じたときに購読者へ何が届くかは relay の実装依存である。draft-ietf-moq-transport-22 が定めているのは、relay が下流の購読を PUBLISH_DONE で閉じる場合として、Malformed Track を検出した場合 (§12.1)、REQUEST_UPDATE を拒否した場合 (§9.5.1)、下流のストリームを FIN で閉じる場合 (§6.4.2.2) である。上流の publisher のセッションが終わったときに relay が下流の購読をどう閉じるかは定められておらず、実リレーで確かめる対象である。配信だけを止めた場合は何も送らないため購読は残る (§7.4 の「A subscriber remains subscribed to a Track at a Relay until it unsubscribes, the upstream publisher terminates the subscription, or the subscription expires.」/ §3.1.2)
- この 2 つの止め方で購読者に何が届くかの違いを実リレーで確かめることが、他実装との interop と relay の離脱の扱いの確認に要る。実リレーでの確認は `TEST_MOQT_URI` を渡す E2E (`tests/e2e/relay/` の `npx vp run e2e-test:relay`) で行う。devtools の UI を実リレーで駆動する先例は `tests/e2e/relay/devtools-publisher-catalog.spec.ts` である

## 設計方針

- Stop の止め方を UI から選べるようにする。候補は次の 3 つ
  - PUBLISH_DONE を送って止める (既定。今の挙動)
  - PUBLISH_DONE を送らずにセッションを閉じる。complete catalog も送らない (送ると購読者の Catalog パネルが空になり、止め方の差ではなく catalog の有無で購読者の表示が変わってしまう)
  - 何も送らずに配信だけ止める (セッションは維持)
- UI は `devtools/src/components/PublisherPanel.tsx` の Stop の隣の select で選ぶ。値は `mode` / `audioDelivery` と同じく URL クエリ (`publishStop`) で保持し、`devtools/src/signals/connectionSettings.ts` の `buildQueryParams` と `isAudioDelivery` と同じ形の許可リストと型ガードで読み書きする。ラベルは英語 (`PUBLISH_DONE` / `Close session` / `Stop sending`) とし、実リレーの E2E から URL で駆動できるようにする
- 「配信だけ止める」では、セッションと `pubSession` を維持したまま、次の送信経路を止める。購読者に何も届かない状態が続くことを確かめられるようにする
  - 映像と音声のフレームの読み出し (`pub.frameReader` / `pub.audioFrameReader` の cancel)
  - 映像と音声の encoder の close
  - catalog の送り直し (`cancelCatalogRepublish`)
  - event timeline は PUBLISH_DONE を送らずに `pub.eventPublisher.value` を外し、`MessageComposer` を無効にする (送ると event トラックに PUBLISH_DONE が届き、「何も送らずに止める」と矛盾する。`MessageComposer` の無効条件も `pub.eventPublisher.value === null` である)
- 「配信だけ止める」の後は、配信中だが送っていないことが分かる表示にし、Stop は押せるままにする (別の止め方でセッションを閉じ直せる)。Publish は押せないままにして、生きている `pubSession` を `startPublishing` が上書きしないようにする (`0739-bug-devtools-publisher-buttons-while-starting.md` と同じ問題を再生産しない)
- 止め方ごとのメッセージの選択と停止対象の分岐は、フックの外に置く純粋な関数に切り出し、`devtools/src/hooks/usePublisher.test.ts` で固定する
- 既定は今の挙動のままにして、既存の操作の意味を変えない
- 購読者側の状態の表示は `0839-bug-devtools-track-end-teardown.md` が変えるため、本 issue は 0839 の完了後に実装する
- devtools の UI は英語表記とする (`CODEBASE.md`)。Debug パネルへ出すログは英語とする (`AGENTS.md`)
- 対象外
  - ライブラリの API 追加。今の `Publisher` の API で足りる範囲で実装する
  - relay 側の挙動の変更

## 完了条件

- 3 つの止め方を UI から選べ、それぞれで送られるメッセージの違いを Debug パネルのログで確認できる
- 実リレー (実リレーが使える環境で `npx vp run e2e-test:relay`) で次を観測して記録する。`TEST_MOQT_URI` 未設定の環境では relay project の spec が skip になる
  - PUBLISH_DONE を送らずにセッションを閉じたとき、購読者に何が届くか (relay が PUBLISH_DONE を代行して送るか、購読が残るか)
  - 何も送らずに配信だけ止めたとき、購読者に何も届かず購読が残ること
  - 差が出なかった場合は、その結果を本 issue に記録する (`0817-add-relay-tests.md` と同じ扱い)
- 止め方ごとのメッセージの選択と停止対象の分岐を、フックの外の純粋な関数に切り出して `devtools/src/hooks/usePublisher.test.ts` で固定する
- 選択した止め方が URL クエリ (`publishStop`) を往復することを `devtools/src/signals/connectionSettings.test.ts` で固定する
- 既定の止め方は従来と同じメッセージを送る
- `npx vp check` / `npx vp test --run` / `npx vp run e2e-test` / `npx vp run e2e-test:relay` が通る

## 参照

- `0839-bug-devtools-track-end-teardown.md`
- `devtools/src/hooks/usePublisher.ts` の `stopPublishing` / `cleanupPublisher`
- `devtools/src/components/PublisherPanel.tsx` の Stop と `stopBtnDisabled`
- `devtools/src/signals/publisher.ts` の `isPublishing` / `pubSession`
- `devtools/src/signals/connectionSettings.ts` の `buildQueryParams` / `isAudioDelivery`
- `devtools/src/hooks/usePublisher.test.ts` / `devtools/src/signals/connectionSettings.test.ts`
- `src/publisher.ts` の `PublisherImpl.done`
- `tests/e2e/relay/` と `tests/e2e/relay/devtools-publisher-catalog.spec.ts` (devtools の UI を実リレーで駆動する先例)
- `0738-bug-devtools-stale-publisher-cleanup.md` / `0739-bug-devtools-publisher-buttons-while-starting.md` (同じ `stopPublishing` / `cleanupPublisher` / ボタン判定を変更する open issue)
- `0817-add-relay-tests.md` (実リレーで確認できない場合の記録の先例)

## 解決方法

- `devtools/src/signals/connectionSettings.ts` に `publishStop` signal と `PUBLISH_STOP_MODES` / `isPublishStopMode` を追加し、URL クエリ `publishStop` で往復させた (既定の `publish-done` は URL に載せない)
- `devtools/src/hooks/usePublisher.ts` に `buildPublishStopPlan(mode)` を追加し、止め方ごとの「送るメッセージ」と「後始末」を純粋な関数に切り出した。`stopPublishing` は 3 分岐になった
  - `publish-done` (既定): complete catalog と各トラックの PUBLISH_DONE (TRACK_ENDED) を送ってからセッションを閉じる (従来と同じ)
  - `close-session`: complete catalog も PUBLISH_DONE も送らずにセッションだけを閉じる
  - `stop-sending`: 何も送らずに送信の経路だけを止め、セッションと PUBLISH は維持する。`stopSendingPaths` を `cleanupPublisher` から切り出し、event timeline の PUBLISH と catalog の PUBLISH を外して送信の再開経路 (購読者の FORWARD による catalog の送り直し、開始処理の続きからのフレーム送信) を塞いだ
- 配信だけ止めた後に Stop を押したときは、何も送らずにセッションを閉じる (`close-session` と同じ)。3 つ目の止め方を作らない
- UI は `PublisherPanel.tsx` の Stop の隣の select で選ぶ (英語ラベル `PUBLISH_DONE` / `Close session` / `Stop sending`、`data-testid="publisher-stop-mode"`)。選んだ止め方は Debug パネルのログ (`[publisher] [STOP] <mode>`) に出す
- テスト: `devtools/src/hooks/usePublisher.test.ts` に 3 つの止め方の段取り、`devtools/src/signals/connectionSettings.test.ts` に URL 往復、`devtools/src/signals/snapshotCoverage.test.ts` に `publishStop` / `sendingStopped` の扱いを追加した

### 実リレーでの観測結果 (`npx vp run e2e-test:relay`、`tests/e2e/relay/devtools-publish-stop.spec.ts`)

止め方を変えても、購読者側の高レベル API の観測値に差は出なかった (差が出なかったため、その事実を記録する)。

- `publishStop=close-session`: 購読者の state=active、停止前の受信 Object=6、停止後 15、購読者の error=なし
- `publishStop=stop-sending`: 購読者の state=active、停止前の受信 Object=6、停止後 8、購読者の error=なし

`stop-sending` では止めた後に publisher の送信数が伸びないことを assert している。`close-session` では relay が PUBLISH_DONE を代行したかどうかを高レベル API から区別できない (正常終了の PUBLISH_DONE は `onError` を呼ばず、state も変わらない。購読の終了をアプリへ通知する経路が無いことが原因で、これは `0842` の範囲)。そのため、ここでは「どちらの止め方でも購読者が異常終了せず、購読が残る」ことだけを固定し、結果をログに残す形にした。

- `npx vp check` / `npx vp test --run` (3905 件) / `npx vp run e2e-test` (108 件) / `npx vp run e2e-test:relay` (8 件) が通る
