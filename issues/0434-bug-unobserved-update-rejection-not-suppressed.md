# update() を fire-and-forget で呼び出した場合の unhandled rejection 抑制が効かない経路がある

- Created: 2026-08-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-unobserved-update-rejection-not-suppressed
- Polished: {YYYY-MM-DD}

## 目的

`Subscriber.update()` (bidi 系・`src/subscriber.ts`) を fire-and-forget で呼び出し、その後に GOAWAY / REQUEST_ERROR / FIN / RESET 等で pending が reject された場合、unhandled rejection が発生し得る経路を解消する。namespace / tracks 系の update() は closed issue 0414 で「async wrapper ではなく catch 付きの Promise を返す」方式に修正されたが、bidi 系 update() は未対応。

## 現状

- `SubscriberImpl.update` (`src/subscriber.ts`) は async であり、`onUpdate` (内部で `bidiSendRequestUpdate`) を await する。返り値の Promise をアプリが観測しない (void で呼ぶ) 場合、後段で発生した reject は async wrapper の無観測側 promise により unhandled rejection になる。
- issue 0406 は `bidiSendRequestUpdate` 内に `promise.catch(() => {})` を追加して「無観測 reject の抑制」としたが、Node 実機での検証により async 関数の return promise の adoption ではこの catch が unhandled rejection を防げないことが判明した (0414 実装時の検証。garbage collection 前の rejection 処理の差異もあり、確実な抑制には「catch を付けた promise を直接返す」形が必要)。
- namespace / tracks 系 update() (closed issue 0414) は「update を非 async にし、catch を付けた promise を返す」方式で解決済みであり、bidi 系は非対称のまま。
- 影響: `void subscriber.update({...})` でアプリが観測しない場合、unhandled rejection イベントが発生し得る (Node / ブラウザでコンソールエラー・クラッシュポリシーに依存)。

## 設計方針

- `SubscriberImpl.update` (またはその呼び出し経路) を、0414 と同じ「catch 付きの Promise を直接返す」方式に変更する (async の wrapper 化をやめる)。await するアプリの動作は変わらず (reject は伝播する)、void で呼ぶアプリのみ unhandled rejection が抑制される。
- `bidiSendRequestUpdate` 内の `promise.catch(() => {})` (0406 由来) は残す (無害かつ直接呼び出し時の防御)。
- 変更対象: `src/subscriber.ts` (update) / `src/session.ts` (onUpdate 経路)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 完了条件

- bidi 系の update() を fire-and-forget で呼び出し、GOAWAY / REQUEST_ERROR / FIN / RESET 相当で pending が reject されても unhandled rejection が発生しないこと。
- await で観測するアプリの動作が変わらないこと (reject が伝播すること)。
- 上記を検証するテストがあること (0414 の fire-and-forget テストと同方式)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.9 / §10.9.1 (REQUEST_UPDATE の失敗時処理)
- 関連: `issues/closed/0414-bug-unsubscribe-pending-update-cleanup.md` (namespace / tracks 系の fire-and-forget 抑制。bidi 系は本 issue の対象として記録)
- 関連: `issues/closed/0406-fix-goaway-pending-request-update-cleanup.md` (`promise.catch` 追加の発端。async wrapper 経由では不完全であることは 0414 実装時に判明)
