# fill 失敗をアプリに通知する手段を追加する

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/add-fill-failure-notification
- Polished: {YYYY-MM-DD}
- Updated: 2026-09-05

## 目的

fill fetch ストリームが reset / Malformed Track で失敗しても、購読は継続する一方でアプリへの通知手段が無い。fill が欠けたことをアプリが検知して再取得を判断できるようにする。

## 現状

- SessionImpl の handleFillFetchStream (`src/session.ts`) は FIN 以外の終了 (reset / Malformed Track 検出) で fill 関連付けを消すだけで、購読の error コールバックには通知しない。
- Malformed Track 検出時はデータストリームの打ち切りのみとし、購読の bidi ストリームには触れない実装 (購読継続の根拠は §5.1.3.1。Malformed 自体の扱いは §2.4.2 を参照) のため、失敗は無音になる。
- ソースコードに「エラー通知の扱いも別途整理する」という残課題の注記がある。

## 設計方針

- fill fetch ストリームの reset / cancel は購読に波及させない (§5.1.3.1) ことを維持し、通知手段だけを追加する (§2.4.2 の通知推奨と両立させる)。
- 通知先 (購読の error コールバックの再利用か fill 専用のコールバックか) と通知内容 (Request ID / 失敗理由) を決める。
- FIN による正常完了では通知しない。

## 完了条件

- fill 失敗時にアプリが失敗を検知できるテストがあること。
- FIN 正常完了では通知が飛ばないことを検証していること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.3.1 (Opening and Closing Fill Fetch Streams)
- draft-ietf-moq-transport-20 §2.4.2 (Malformed Tracks。SHOULD deliver an error to the application)
- 関連: `issues/closed/0459-draft-20-handle-fill-vs-subscription-delivery.md` (fillDelivered 導入済み。本 issue はその並列の後続で、失敗通知を扱う。統計分離は 0463 が扱う)
