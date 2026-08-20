# onDoneInternal の誤コメントを実体に合わせて修正する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-on-done-internal-comment
- Polished: 2026-08-20

## 目的

`src/session.ts` の `onDoneInternal` 内のコメント「// まずストリームを閉じる（FIN を送信）」が、`closePublisherStream` の実体（データ送信ストリーム（subgroup 単方向ストリーム）の閉鎖）と食い違っているため、実体に合わせて修正する。closed issue 0339 の解決方法で約束されながら未修正のまま残っている。なお 0339 の解決方法 item 3 は「`onDoneInternal` コメント修正」と「`sendPublishDone` の仕様参照を draft-19 Section 3.3.2 / 10.11 に更新」の 2 項目から成るが、後者は 0370 で実施済みのため、本 issue はコメント修正のみを対象とする。

## 現状

- `src/session.ts` の `onDoneInternal` 内に「// まずストリームを閉じる（FIN を送信）」というコメントがある。
- 実際の実行順序は「データ送信ストリーム（subgroup 単方向ストリーム）閉鎖（`closePublisherStream`）→ PUBLISH_DONE 送信 → リクエストストリーム FIN（`publishSendPublishDone` 内の `writer.close()`）」であり、コメントは FIN の送信対象を誤って説明している。

## 設計方針

- 挙動は変更せず、コメントのみを修正する。
- 現行の 2 行構成（1 つ目のコメント +「// その後 PUBLISH_DONE を送信」）を踏襲し、1 つ目のコメントを「// データ送信ストリーム（subgroup 単方向ストリーム）を閉じる」等の内容に修正する。
- 2 つ目のコメント「// その後 PUBLISH_DONE を送信」は既に正しいため現状維持とする。

## 完了条件

- `src/session.ts` の `onDoneInternal` の 1 つ目のコメントが、実際の実行順序（データ送信ストリーム閉鎖 → PUBLISH_DONE → リクエストストリーム FIN）を正しく説明していること。2 つ目のコメント「// その後 PUBLISH_DONE を送信」は現状維持。
- `CHANGES.md` の `## develop` に本修正の記載があること（doc コメント修正のため `### misc` サブセクションに記載する。`shiguredo-changelog` 参照）。
- 挙動変更がないこと（`vp check` / `tsc --noEmit` / `vp test run` が通ること）。

## 参照

- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE)（「A sender MUST NOT send PUBLISH_DONE until it has closed all streams it will ever open」）
- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure)（「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN.」）
- 関連: `issues/closed/0339-draft-19-graceful-request-stream-closure.md`（コメント修正を約束した経緯）
- 関連: `0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（本 issue はそこから分離されたコメント修正）
- 関連: `0366-add-delivery-timeout-enforcement.md`（同じ `onDoneInternal` / `closePublisherStream` を変更対象に含むため、実装順序を調整する）

## 解決方法

未着手。
