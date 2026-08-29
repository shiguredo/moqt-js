# e2e に FETCH 受信経路の実ワイヤ検証がない

- Created: 2026-08-29
- Completed: {YYYY-MM-DD}
- Branch: feature/add-e2e-fetch-coverage
- Polished: {YYYY-MM-DD}

## 目的

FETCH (Standalone Fetch / Joining Fetch) の受信経路は unit test の合成ストリーム注入でのみ検証されており、実サーバーとのワイヤを通じた検証が存在しない。0427 のように受信側の挙動を厳格化 (未完成 Object + FIN でセッションクローズ) する変更では、実サーバーの FIN / End of Range レコード / payload 境界の実装差が誤検出・見逃しに直結するため、実ワイヤの回帰門が必要である。

## 現状

- `tests/e2e/` の既存 spec は connect / pubsub / webtransport-devtools の 3 種。connect と pubsub は `test.describe.skip` で全体停止中 (内部に `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` 未設定時 skip も併せ持つ)。devtools spec は実接続しない UI テスト。
- `session.fetch()` を呼ぶ箇所は `src/session.test.ts` のみ。devtools の `useSubscriber.ts` に Joining Fetch 経路があるが、それを通過する e2e は pubsub の subscription 側からしか発生しない (現状 pubsub 自体が skip)。
- CI の e2e ジョブは走るが、実質的に実行される FETCH 経路の検証は 0 本。
- §10.12.3 (Fetch Handling) は Object 0 件の FETCH_HEADER + FIN など終了形のバリエーションを規定しており、サーバー実装差が出やすい領域である。

## 設計方針

- `tests/e2e/fetch.spec.ts` を新設し、`pubsub.spec.ts` と同じ env-gate 方針 (実サーバー設定がある環境でのみ走る) で Standalone Fetch の最小シナリオを追加する: 一定期間 publish された namespace / track に対し、`{0,0}` からの範囲指定で FETCH を発行し、(a) error コールバックが呼ばれない、(b) end が通知される、(c) 取得 Object 数が publish 済み Object 数と矛盾しない、を成功条件とする。
- 既存 suite の `test.describe.skip` は実サーバー側の事情 (CI で常に走らない理由) に紐づく可能性があり、pubsub / connect の再有効化判断は本 issue の範囲外 (fetch.spec は `test.skip(!MOQT_URI, ...)` の env-gate のみで describe.skip を使わない)。
- Joining Fetch は devtools の購読フロー経由で間接的に叩けるが、明示的な e2e 化は今回のスコープに含めない (Standalone Fetch で FETCH 応答の受信経路全般をカバーできるため、まず 1 シナリオに絞る)。

## 完了条件

- `tests/e2e/fetch.spec.ts` に Standalone Fetch の最小シナリオが存在し、`TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` 設定環境で走ったときに FETCH 受信 (end 通知 + error ゼロ) を検証すること。
- 環境変数未設定時はスキップとして記録されること (暗黙の成功扱いにしない)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §10.12.3 (Fetch Handling)
- draft-ietf-moq-transport-19 §11.4 (Streams / FIN 時の未完成 Object)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（Fetch 受信判定を合成 FIN のみで検証した旨を記載）

## 解決方法

未着手。
