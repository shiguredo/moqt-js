# namespace の完全一致判定が relay の prefix 返却に依存している

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/update-namespace-match-semantics
- Polished: {YYYY-MM-DD}

## 目的

`tests/e2e/relay/namespace-announcement.spec.ts` と `tests/e2e/relay/namespace-discovery-subscribe.spec.ts` は、`SUBSCRIBE_NAMESPACE` で受信した NAMESPACE を告知した namespace と完全一致で比較している。draft-ietf-moq-transport-22 §4.2 は NAMESPACE 自体が prefix であり得るとするため、relay がより広い prefix を返す実装に変わると、発見できていてもテストが失敗する。現在の relay は告知された完全な namespace を返すため通っているが、前提が暗黙になっている。

## 現状

- 両 spec は `candidate.length === expected.length && candidate.every(...)` で完全一致を判定する
- `namespace-announcement.spec.ts` は NAMESPACE の受信と NAMESPACE_DONE の確認に同じ判定を使う
- `namespace-discovery-subscribe.spec.ts` は発見の poll、発見結果の取り出し、NAMESPACE_DONE の確認に同じ判定を使う
- draft-ietf-moq-transport-22 §4.2 は NAMESPACE が prefix であり得ることを許す
- relay の実装は告知された完全な namespace を返す (2026-11-02 / 11-03 の実行で確認)

## 設計方針

次のどちらかを選ぶ。

- 案 A: relay が完全な namespace を返す前提を spec のコメントに明記し、prefix を返す実装に変わったらテストを更新する。現状の挙動を固定する
- 案 B: 受信した NAMESPACE が告知した namespace の prefix であることを許す判定に変える (「告知した namespace が受信した NAMESPACE で始まる」)。relay の実装差に強くなるが、テストの意味が広がる

draft-22 §4.2 の意図 (購読者は NAMESPACE で列挙された範囲を知る) に照らすと、案 B が仕様に忠実である。ただし、対象の namespace を一意に特定する用途では完全一致の方が誤検知が少ない。判定の目的 (対象の namespace の告知を見つける) を明確にしたうえで決める。

## 完了条件

- 完全一致の前提または prefix を許す判定のどちらかに決まり、2 つの spec で同じ判定を使う
- 判定の根拠 (draft-22 §4.2) をコメントに書く
- 実リレーで通る
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。テストのみの変更のため `### misc` にも記載しない。

## 参照

- `tests/e2e/relay/namespace-announcement.spec.ts`
- `tests/e2e/relay/namespace-discovery-subscribe.spec.ts`
- draft-ietf-moq-transport-22 §4.2
- `issues/closed/0892-test-relay-discovered-namespace-subscribe.md` の 3 周目レビュー (完全一致の前提)
