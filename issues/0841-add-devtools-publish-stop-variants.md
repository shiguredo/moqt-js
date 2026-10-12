# moqt-devtools の publish 停止に、止め方のバリエーションを足す

- Created: 2026-10-12
- Completed: {YYYY-MM-DD}
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

{未着手}
