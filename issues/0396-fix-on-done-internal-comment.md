# onDoneInternal の誤コメントを実体に合わせて修正する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-on-done-internal-comment
- Polished: {YYYY-MM-DD}

## 目的

`src/session.ts` の `onDoneInternal` 内のコメント「// まずストリームを閉じる（FIN を送信）」が、`closePublisherStream` の実体（データ送信ストリームの閉鎖）と食い違っているため、実体に合わせて修正する。closed issue 0339 の解決方法で約束されながら未修正のまま残っている。

## 現状

- `src/session.ts` の `onDoneInternal` 内に「// まずストリームを閉じる（FIN を送信）」というコメントがある。
- 実際の実行順序は「データストリーム閉鎖（`closePublisherStream`）→ PUBLISH_DONE 送信 → リクエストストリーム FIN（`publishSendPublishDone` 内の `writer.close()`）」であり、コメントは FIN の送信対象を誤って説明している。

## 設計方針

- 挙動は変更せず、コメントのみを「データストリーム閉鎖 → PUBLISH_DONE → リクエストストリーム FIN」の内容に修正する。

## 完了条件

- `src/session.ts` の `onDoneInternal` のコメントが、実際の実行順序（データストリーム閉鎖 → PUBLISH_DONE → リクエストストリーム FIN）を正しく説明していること。
- 挙動変更がないこと（`vp check` / `tsc --noEmit` / `vp test run` が通ること）。

## 参照

- 関連: `issues/closed/0339-draft-19-graceful-request-stream-closure.md`（コメント修正を約束した経緯）
- 関連: `0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（本 issue はそこから分離されたコメント修正）

## 解決方法

未着手。
