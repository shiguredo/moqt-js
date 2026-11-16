# log / metrics の catalog namespace を / 区切りにする

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.2.2 は catalog の `namespace` を `/` で区切った文字列と定義する。§9.2 と §10.2 は log / metrics の track namespace をこのフィールドで表すと定め、§5.6.17 の例は `"moq-syslog.arpa/logs-v1/%resourceId%"` と `"metrics.moq.arpa/metrics-v1/%resourceId%"` を示す。

現行実装の `MOQLOG_NAMESPACE_TEMPLATE` と `MOQMETRICS_NAMESPACE_TEMPLATE` は、MOQT draft-23 §8.8 の `-` 区切りと `.HH` エスケープで組み立てた文字列 (`logs.2emoq.2earpa-v1-%resourceId%` など) である。`/` を含まないため、draft-02 の subscriber からは 1 フィールドの namespace として解釈され、意図した 3 フィールドにならない。

## 現状

- `src/observability.ts` の `observabilityNamespaceTemplate` は `formatTrackNamespace(fields)` の結果に `-%resourceId%` を連結する。`formatTrackNamespace` は MOQT §8.8 の表現を作るため、ドットが `.2e` にエスケープされ、フィールドが `-` で区切られる
- `src/moqlog.ts` の `MOQLOG_NAMESPACE_TEMPLATE` と `src/moqmetrics.ts` の `MOQMETRICS_NAMESPACE_TEMPLATE` がこの関数を使う
- `src/moqlog.test.ts` と `src/moqmetrics.test.ts` は `"logs.2emoq.2earpa-v1-%resourceId%"` と `"metrics.2emoq.2earpa-v1-%resourceId%"` を期待値として固定している
- `src/observability.ts` の `observabilityTrackNamespace` は 3 フィールドの配列を返す。catalog に載せるのは文字列、SUBSCRIBE に渡すのは配列であり、両者の表現が混在している

## 設計方針

- catalog の `namespace` に載せる文字列は `/` 区切りにする。`observabilityNamespaceTemplate` を `/` 区切りで組み立てる関数に置き換える
- MOQT の SUBSCRIBE に渡す namespace 配列は、`/` 区切りの文字列から作る。分割と `%resourceId%` の展開を 1 つの関数にまとめる。0972 の namespace 分割 helper と共有する
- MOQT §8.8 の `-` 区切り表現は、ログ表示や msf fragment のように MOQT の直列化が要求される箇所だけで使う。catalog 用の文字列とは別の関数にする
- 0972 が namespace の型を配列に変える場合は、本 issue の template もそれに合わせる。0972 の決定に追随する
- 期待値を固定しているテストを `/` 区切りに更新する

## 完了条件

- `MOQLOG_NAMESPACE_TEMPLATE` が `"moq-syslog.arpa/logs-v1/%resourceId%"` になる。単体テストで固定する
- `MOQMETRICS_NAMESPACE_TEMPLATE` が `"metrics.moq.arpa/metrics-v1/%resourceId%"` になる。単体テストで固定する
- 両 template から `%resourceId%` を展開した 3 フィールドの namespace 配列を作れる。単体テストで固定する
- `%resourceId%` を含む template を catalog の `namespace` として encode / decode できる。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
