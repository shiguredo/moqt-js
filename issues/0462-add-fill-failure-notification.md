# fill 失敗をアプリに通知する手段を追加する

- Created: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/add-fill-failure-notification
- Polished: {YYYY-MM-DD}

## 目的

fill fetch ストリームが reset / Malformed Track で失敗しても、購読は継続する一方でアプリへの通知手段が無い。fill が欠けたことをアプリが検知して再取得を判断できるようにする。

## 現状

- SessionImpl の handleFillFetchStream (`src/session.ts`) は FIN 以外の終了 (reset / Malformed Track 検出) で fill 関連付けを消すだけで、購読の error コールバックには通知しない。
- Malformed Track 検出時はデータストリームの打ち切りのみとし、購読の bidi ストリームには触れない方針 (§5.1.3.1) のため、失敗は無音になる。
- ソースコードに「エラー通知の扱いも別途整理する」という残課題の注記がある。

## 設計方針

- fill の成否は購読に波及させない (§5.1.3.1) ことを維持し、通知手段だけを追加する。
- 通知先 (購読の error コールバックの再利用か fill 専用のコールバックか) と通知内容 (Request ID / 失敗理由) を決める。
- FIN による正常完了では通知しない。

## 完了条件

- fill 失敗時にアプリが失敗を検知できるテストがあること。
- FIN 正常完了では通知が飛ばないことを検証していること。
- `CHANGES.md` の `## develop` に `[ADD]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §5.1.3.1 (Opening and Closing Fill Fetch Streams)
- 関連: fill と subscription の受信経路分離 (fillDelivered 導入) の後続課題
