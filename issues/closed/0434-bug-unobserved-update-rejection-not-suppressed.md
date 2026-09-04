# update() を fire-and-forget で呼び出した場合の unhandled rejection 抑制が効かない経路がある

- Created: 2026-08-25
- Completed: 2026-09-04
- Branch: feature/fix-unobserved-update-rejection-not-suppressed
- Polished: 2026-08-28

## 目的

`Subscriber.update()` (bidi 系・`src/subscriber.ts`) を fire-and-forget で呼び出し、その後に GOAWAY / REQUEST_ERROR / FIN / RESET 等で pending が reject された場合、unhandled rejection が発生し得る経路を解消する。namespace / tracks 系の update() は closed issue 0414 で「async wrapper ではなく catch 付きの Promise を返す」方式に修正されたが、bidi 系 update() は未対応。

## 現状

- `SubscriberImpl.update` (`src/subscriber.ts` 428-436 行) は async であり、内側で `this.onUpdate(...)` を await する。返り値の Promise をアプリが観測しない (`void subscriber.update({...})` で呼ぶ) 場合、後段で発生した reject は async 関数が生成する外側 Promise の adoption 経由で伝播し、そこにハンドラが付かないため unhandled rejection になる。
- issue 0406 は `bidiSendRequestUpdate` 内に `promise.catch(() => {})` (`src/session/bidi.ts` 1511 行) を追加して「無観測 reject の抑制」としたが、その catch が付いているのは内側 Promise であり、`SubscriberImpl.update` の async wrapper (および `impl.onUpdate` の async wrapper) が返す外側 Promise は adoption によって別インスタンスとして生成されるため、そちらにはハンドラが付かず抑制が効かない。0414 実装時に Node 実機でこの adoption 由来の挙動を確認済み。
- 現状の reject トリガーとして bidi 系 SUBSCRIBE で確実に到達する経路: REQUEST_ERROR (既存)、GOAWAY (0406 の掃除)、FIN (0422 で bidi 系にも掃除が入った)。将来加わる経路: RESET 経路 (open issue 0432 で対応予定)、bidi 系 unsubscribe 経路 (open issue 0433 で対応予定)。
- namespace / tracks 系 update() (closed issue 0414) は「update を非 async にし、catch を付けた promise を直接返す」方式で解決済み (`src/session.ts` の `createNamespaceSubscription` / `createTracksSubscription` 内の update 実装で確認済み)。bidi 系 (`SubscriberImpl.update`) のみ非対称のまま。
- 影響: `void subscriber.update({...})` でアプリが観測しない場合、REQUEST_ERROR / GOAWAY で reject されると unhandled rejection イベントが発生し得る (Node / ブラウザでコンソールエラー・クラッシュポリシーに依存)。

## 設計方針

- `SubscriberImpl.update` (`src/subscriber.ts`) の 1 箇所のみを非 async 化し、内側の `this.onUpdate(...)` が返す Promise に `.catch(() => {})` を付けてから同じ Promise を返す (0414 の namespace / tracks 側と同型)。await するアプリの動作は変わらず (reject は伝播する)、void で呼ぶアプリのみ unhandled rejection が抑制される。
- `session.ts` の `impl.onUpdate` 設定 (1724 行の subscribe() / 3715 行の受信 PUBLISH の 2 箇所) は変更しない。呼び出し側の外殻 `SubscriberImpl.update` を非 async 化して同一 Promise インスタンスに catch を付ければ、adoption 由来の unhandled rejection は最外殻で吸収されるため、内側 wrapper (`impl.onUpdate` の async 化) は挙動に影響しない。
- state === "closed" のガードは現行の Promise reject 挙動を維持する。非 async 化に伴い素朴に `throw new Error(...)` を残すと同期 throw に化けて fire-and-forget 呼び出しの観測挙動が変わるため、`const rejected = Promise.reject(new Error("Subscriber is closed")); rejected.catch(() => {}); return rejected;` として同じ Promise インスタンスに catch ハンドラを登録してから同一インスタンスを返す (`.catch` は resolved な別 Promise を返すため `return Promise.reject(...).catch(() => {})` と書くと await 側に reject が伝播しなくなる。22 行の onUpdate 経路と同型の装着)。これで fire-and-forget では unhandled rejection にならず、await するアプリには reject が伝播する。
- `onUpdate` 未設定時は `Promise.resolve()` を返す (現行の async 実装は暗黙的に resolve していた挙動を明示的に再現する)。
- `bidiSendRequestUpdate` 内の `promise.catch(() => {})` (0406 由来) は残す (無害かつ直接呼び出し時の防御)。
- 変更対象: `src/subscriber.ts` (`SubscriberImpl.update` の非 async 化)、`src/session/bidi.test.ts` (テスト追加。fire-and-forget での REQUEST_ERROR / GOAWAY 経路 unhandled rejection なし、await で reject 伝播、state === "closed" 時の Promise reject 挙動維持)、`CHANGES.md`。`src/session.ts` の onUpdate 経路は変更しない。
- 実装順序: 本 issue は open issue 0432 / 0433 に先行して実装する。async wrapper 解消は独立して施工可能で、既存の GOAWAY / REQUEST_ERROR / FIN での fire-and-forget 抑制も同時に効くようになる。0432 / 0433 実装後に RESET 経路 / bidi unsubscribe 経路も追加テストで最終確認する。0433 の完了条件「fire-and-forget の update() が unhandled rejection にならないこと」は本 issue 実装で担保されるため、0434 → 0433 の順が自然。

## 完了条件

- bidi 系 `SubscriberImpl.update()` を fire-and-forget で呼び出し、GOAWAY / REQUEST_ERROR / FIN 相当で pending が reject されても unhandled rejection が発生しないこと (RESET 経路 / bidi unsubscribe 経路は 0432 / 0433 実装後に別 PR で追加確認)。
- await で観測するアプリの動作が変わらないこと (reject が Promise で伝播する。同期 throw に化けないこと)。
- state === "closed" 時に返る Promise が rejected であり、同期 throw に変わらないこと。fire-and-forget 呼び出しで unhandled rejection にならないこと。
- `onUpdate` 未設定時に `Promise.resolve()` が返ること (現行の暗黙 resolve 挙動を維持)。
- 上記を検証するテストがあること (0414 の fire-and-forget テストと同方式で REQUEST_ERROR と GOAWAY の 2 経路を検証)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 / §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0414-bug-unsubscribe-pending-update-cleanup.md` (namespace / tracks 系の fire-and-forget 抑制。update() を非 async 化し catch 付き Promise を直接返す方式の先例)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (`promise.catch` 追加の発端。async wrapper 経由では adoption によって別インスタンスの外側 Promise が生成されるため不完全であることは 0414 実装時に確認)
- 関連: `issues/closed/0422-bug-fin-path-pending-request-update-leak.md` (bidi 系 FIN 経路の pending 掃除。本 issue の抑制対象の 1 経路)
- 関連: `issues/0432-bug-reset-path-pending-request-update-leak.md` (RESET 経路の pending 掃除。本 issue 実装後にテスト追加で最終確認)
- 関連: `issues/0433-bug-bidi-unsubscribe-pending-update-cleanup.md` (bidi 系 unsubscribe 経路の pending 掃除。同 issue の fire-and-forget 抑制の完了条件は本 issue で担保)

## 解決方法

`src/subscriber.ts` の `SubscriberImpl.update` を非 async 化し、同一インスタンスに catch ハンドラを登録した Promise を直接返すようにした。

- onUpdate ありの経路は返り値をそのまま返し、await する呼び出しには reject が伝播する
- onUpdate の同期 throw は理由値そのままの rejected な Promise に変換する (旧 async 実装との等価性維持)
- closed 時は同期 throw ではなく rejected な Promise を返し、onUpdate 未設定時は解決済み Promise を返す
- テストは `src/session/bidi.test.ts` に 8 本 (5 経路の抑制と await 伝播 3 本)、`src/subscriber.test.ts` に 5 本 (同期非 throw・抑制・未設定・同期 throw 変換・同一インスタンス) を追加する
- `CHANGES.md` の `## develop` に `[FIX]` を追記する
