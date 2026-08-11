# 0390 に bidiReadRequestStreamMessages の export 維持注記を追加する

- Created: 2026-08-07
- Completed: {YYYY-MM-DD}
- Branch: feature/doc-0390-keep-export-note
- Polished: {YYYY-MM-DD}

## 目的

issue 0370（PUBLISH_OK 後にピアが FIN すると PUBLISH_DONE が送信されない）のテストが `bidiReadRequestStreamMessages`（`src/session/bidi.ts`）を駆動するため、issue 0390（外部から使用されていない内部関数の export を非公開化する）で同関数の export を維持する旨の注記を 0390 の issue ファイルに追加する。0370 を先に実装し、0390 を後に実施する前提のため、0370 のテストが破綻しないための調整である。

## 現状

- issue 0390 の対象リストに `src/session/bidi.ts` の `bidiReadRequestStreamMessages` が含まれる。
- 0370 のテストは `bidiReadRequestStreamMessages` を直接駆動するため、0390 が export を除去すると 0370 のテストが破綻する。
- 0390 の issue ファイルには 0370 への言及・export 維持の注記が存在しない。

## 設計方針

- 0390 の issue ファイルに「`bidiReadRequestStreamMessages` は 0370 のテストで使用するため export を維持する」旨の注記を追加する。
- 0390 の非公開化対象リストから `bidiReadRequestStreamMessages` を除外する。

## 注記 (0374 実装時)

- 0374 (PUBLISH_DONE なしの FIN で subscriber の終了通知が失われる) のテストも `bidiReadRequestStreamMessages` (subscribe ロール) を駆動するため、0390 への export 維持注記に 0374 分も含めること (0374 の設計方針に「0397 が 0370 向けに追加する注記に 0374 分も含める」と明記済み)。あわせて、0374 で新設した `notifySubscriberFin` と `FIN_WITHOUT_PUBLISH_DONE_MESSAGE` は production (session.ts) からも使用されるため 0390 の非公開化対象外である旨を 0390 側に注記する。

## 完了条件

- 0390 の issue ファイルに、`bidiReadRequestStreamMessages` の export を維持する旨の注記と、0370 への相互参照が追加されていること。

## 参照

- 関連: `0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（export 維持を要求する側）
- 関連: `0390-moqt-draft-19-unexport-internal-symbols.md`（非公開化対象）

## 解決方法

未着手。
