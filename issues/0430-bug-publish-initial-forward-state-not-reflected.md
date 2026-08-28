# publish({ forward: false }) の初期 Forward State が PublisherImpl に反映されない

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-initial-forward-state-not-reflected
- Polished: 2026-08-28

## 目的

`publish({ forward: false })` でアプリが初期 Forward State を false に指定しても、ローカル `PublisherImpl` (`src/publisher.ts`) の `forwardState` は生成直後に常に初期値 true のままになる。`publish()` (`src/session.ts`) は `buildPublishParameters` 経由で FORWARD=0 を PUBLISH メッセージに載せるだけで、ローカルの Publisher に反映しない。draft-ietf-moq-transport-19 §5.1 は「The initiator of the subscription sets the initial Forward State in either PUBLISH or SUBSCRIBE.」と定めており、SUBSCRIBE 送信側 (`src/session.ts` の `subscribe()` は `impl.setForwardState(options?.forward ?? true)` で反映済み) と非対称になっている。PUBLISH 送信側にも同じ反映を追加し、PUBLISH_OK 受信前の期間に `Publisher.forwardState` が `options.forward` を反映するようにする。

## 現状

- `publish()` (`src/session.ts` の `publish()` 内、1549 行付近の `new PublisherImpl(...)` インライン生成) は `options.forward` を `buildPublishParameters` (`src/session/params.ts`) 経由で PUBLISH メッセージに載せる (FORWARD=0 のみ明示的に載せ、true / 省略時は載せない) が、生成直後の PublisherImpl に `setForwardState(options.forward)` を呼ばない。
- `PublisherImpl` (`src/publisher.ts`) の `publisherForwardState` は初期値 true (`src/publisher.ts` 120 行付近)。
- 対照として `subscribe()` (`src/session.ts` 1707 行付近) は `impl.setForwardState(options?.forward ?? true)` を呼び、SubscriberImpl の初期 forwardState に `options.forward` を反映している。
- `bidiReadPublishResponse` の PUBLISH_OK 処理 (`src/session/bidi.ts` 367-368 行) は `extractForwardState(decoded.parameters)` を FORWARD の有無に関わらず無条件に `pending.impl.setForwardState(...)` へ反映する。これは draft-ietf-moq-transport-19 §10.2.17「If the parameter is omitted from REQUEST_UPDATE, the value for the subscription remains unchanged. If the parameter is omitted from any other message, the default value is 1.」および §5.1「The subscriber can send PUBLISH_OK or REQUEST_UPDATE to update the Forward State.」に沿った正しい実装であり、変更しない。
- 結果として、`publish({ forward: false })` を実行した直後 (PUBLISH_OK 受信前) の観測では `Publisher.forwardState` が `options.forward` を反映しない状態になる。アプリが送信停止状態から開始したい (初期値 false) 意図と、生成直後に `forwardState === true` になる実装との齟齬が生じる。PUBLISH_OK 受信後は §10.2.17 のとおり (FORWARD 省略なら 1、FORWARD=0 なら 0、FORWARD=1 なら 1) に更新される。

## 設計方針

- `publish()` の PublisherImpl 生成直後に `impl.setForwardState(options?.forward ?? true)` を追加し、SUBSCRIBE 送信側 (`session.ts` 1707 行) と同じパターンで初期 Forward State を反映する。
- `options.forward` が undefined の場合は true (`options?.forward ?? true`)。§10.2.17 の「omitted from any other message = default 1」と一致し、subscribe 側の統一パターンにも合致する。
- `bidiReadPublishResponse` の PUBLISH_OK 反映 (`src/session/bidi.ts` 367-368 行) は §10.2.17 の一般則「PUBLISH_OK で FORWARD 省略 = default 1」と §5.1「subscriber can send PUBLISH_OK ... to update the Forward State」に従い、現行の無条件反映を維持する。ここに「FORWARD 存在時のみ反映」ガードを入れると、subscriber が bare PUBLISH_OK で「Forward State を 1 に更新する」意図を送っても publisher が反映しなくなり、仕様違反になる。
- `PublisherImpl` (`src/publisher.ts`) の初期値 true (`publisherForwardState = true`) は変更しない。`publish()` から明示的に `setForwardState` を呼ぶ構図が SUBSCRIBE 側と対称になる。
- 変更対象: `src/session.ts` (`publish()` の PublisherImpl 生成直後に `impl.setForwardState(options?.forward ?? true)` を追加)、該当テスト (`src/session/publish.test.ts` など)、`CHANGES.md`。

## 0416 との違い

- 0416 (受信 REQUEST_UPDATE の FORWARD 省略) は §10.2.17 の「omitted from REQUEST_UPDATE = the value remains unchanged」に基づき、REQUEST_UPDATE 受信側で「FORWARD 存在時のみ反映」を追加した。REQUEST_UPDATE 特則を根拠にする。
- 0430 は §10.2.17 の一般則「omitted from any other message = default 1」の対象である PUBLISH_OK には応答側ガードを入れない。真の問題は「initiator が指定した `options.forward` がローカルに反映されない (PUBLISH 送信直後～ PUBLISH_OK 受信前の期間の初期値)」ことであり、応答側の反映は §10.2.17 と §5.1 のとおり維持する。
- したがって 0416 と 0430 は同構図ではない。0416 は応答側ガード、0430 は送信側の初期値反映。

## 完了条件

- `publish({ forward: false })` の PUBLISH_OK 受信前の時点で `Publisher.forwardState` が false であること (初期値反映)。
- `publish({ forward: true })` または `publish()` (省略) の PUBLISH_OK 受信前の時点で `Publisher.forwardState` が true であること (回帰ガード)。
- PUBLISH_OK 受信後の挙動は現行のままであること: 対向が FORWARD=1 を含む、または FORWARD を省略した PUBLISH_OK を返した場合は `Publisher.forwardState` が true になり (§10.2.17 の default 1)、FORWARD=0 を含む PUBLISH_OK を返した場合は false になる。
- 上記を検証するテストがあること (`publish({ forward: false })` 直後の観測、`publish({ forward: true })` 直後の観測、対向 PUBLISH_OK 応答による反映の 3 系統)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §5.1 (Subscriptions / 「The initiator of the subscription sets the initial Forward State in either PUBLISH or SUBSCRIBE. The subscriber can send PUBLISH_OK or REQUEST_UPDATE to update the Forward State.」)
- draft-ietf-moq-transport-19 §10.2.17 (FORWARD Parameter / 「If the parameter is omitted from REQUEST_UPDATE, the value for the subscription remains unchanged. If the parameter is omitted from any other message, the default value is 1.」)
- 関連: `issues/closed/0416-bug-publish-forward-omitted-overwrite.md` (受信 REQUEST_UPDATE 経路の FORWARD 反映を §10.2.17 の REQUEST_UPDATE 特則に基づき「FORWARD 存在時のみ反映」に修正した先例。本 issue の PUBLISH_OK ガード案を採らない根拠でもある)
