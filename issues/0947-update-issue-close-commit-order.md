# issue のクローズ手順でコード変更が解決方法の追記より後になっている

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-issue-close-commit-order
- Polished: {YYYY-MM-DD}

## 目的

`shiguredo-issues` は、コード変更で issue を closed にするときの流れを「コード変更のコミット → 解決方法と Completed の追記 → `git mv` で移動」と定める。しかし 0889 以降の auto-resolve では、解決方法の追記と移動を先に行い、コード変更を後からコミットする順序になっている。履歴上、検証結果を含む解決方法がコード変更の存在しない時点に載り、追跡性が落ちる。運用の手順と実際の順序を一致させる。

## 現状

- `issues/closed/0890-bug-publish-namespace-pending-settle.md` は `0890 解決方法を追記する` → `0890 closed ...` → `0890 送信待ちの ...` の順
- `issues/closed/0891-add-high-level-goaway-migration.md` は `0891 解決方法を追記する` → `0891 closed ...` → `0891 高レベル API ...` → レビュー修正の順
- `issues/closed/0892-test-relay-discovered-namespace-subscribe.md` は `0892 解決方法を追記する` → `0892 closed ...` → `0892 告知を発見した ...` の順
- レビュー修正のコミットが解決方法の追記より後になることもあるため、解決方法の記述と最終実装が一時期ずれる
- squash merge のため最終ツリーは正しく、履歴の追跡性だけが問題である

## 設計方針

auto-resolve の手順を、実装 (レビュー反映を含む) → 解決方法の追記 → 移動の順に改める。

- 実装とレビュー反映を先にコミットする
- レビューで実装が変わった場合は、解決方法の追記を最後のレビュー反映後に行う
- 解決方法の追記と移動の 2 コミットは最後に置く
- 手順が守られているかを確認するチェック (auto-resolve の手順書か、レビューの観点) を足す

手順はスキル (`auto-resolve`) と `shiguredo-issues` の両方に影響するため、どちらに書くかを決める。

## 完了条件

- auto-resolve の手順と shiguredo-issues のクローズ手順が一致している
- 次回以降の issue で、コード変更 → 解決方法 → 移動の順でコミットされる
- 既存の closed issue の履歴は書き換えない (squash merge 済みのため)

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。ドキュメントと運用のみの変更のため `### misc` にも記載しない。

## 参照

- `/Users/voluntas/.agents/skills/auto-resolve/SKILL.md`
- `/Users/voluntas/.agents/skills/shiguredo-issues/SKILL.md`
- `issues/closed/0890-bug-publish-namespace-pending-settle.md` / `0891-add-high-level-goaway-migration.md` / `0892-test-relay-discovered-namespace-subscribe.md` の git 履歴
