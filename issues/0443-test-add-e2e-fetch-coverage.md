# e2e に FETCH 受信経路の実ワイヤ検証がない

- Created: 2026-08-29
- Updated: 2026-09-05
- Completed: {YYYY-MM-DD}
- Branch: feature/add-e2e-fetch-coverage
- Polished: {YYYY-MM-DD}

## 目的

FETCH (draft-20 §10.13 の単一 FETCH。範囲は LOCATION_FILTER パラメータ) の受信経路は unit test の合成ストリーム注入でのみ検証されており、実サーバーとのワイヤを通じた検証が存在しない。0427 のように受信側の挙動を厳格化 (未完成 Object + FIN でセッションクローズ) する変更では、実サーバーの FIN / End of Range レコード / payload 境界の実装差が誤検出・見逃しに直結するため、実ワイヤの回帰門が必要である。旧 Joining FETCH の用途は FILL_PARAMETERS に寄せられたため対象外。

## 現状

- `tests/e2e/` の既存 spec は connect / pubsub / webtransport-devtools の 3 種。connect と pubsub は `test.describe.skip` で全体停止中 (内部に `TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` 未設定時 skip も併せ持つ)。devtools spec は実接続しない UI テスト。
- `session.fetch()` を呼ぶ箇所は `src/session.test.ts` のみ。devtools の catalog 取得は SUBSCRIBE + FETCH 経路 (Joining FETCH 非依存) であり、それを通過する e2e は pubsub の subscription 側からしか発生しない (現状 pubsub 自体が skip)。
- CI の e2e ジョブは走るが、実質的に実行される FETCH 経路の検証は 0 本。
- draft-ietf-moq-transport-20 §10.13 (FETCH。空範囲時は FETCH_HEADER + FIN) / §11.4.4.2 (End of Range) は終了形のバリエーションを規定しており、サーバー実装差が出やすい領域である。

## 設計方針

- `tests/e2e/fetch.spec.ts` を新設し、`pubsub.spec.ts` と同じ env-gate 方針 (実サーバー設定がある環境でのみ走る) で FETCH の最小シナリオを追加する: 一定期間 publish された namespace / track に対し、filter 省略 (全オブジェクト。既定は {0, 0} から Largest Object まで) または LocationFilter 指定で FETCH を発行し、(a) error コールバックが呼ばれない、(b) end が通知される、(c) 取得 Object 数が publish 済み Object 数と矛盾しない、を成功条件とする。
- 既存 suite の `test.describe.skip` は実サーバー側の事情 (CI で常に走らない理由) に紐づく可能性があり、pubsub / connect の再有効化判断は本 issue の範囲外 (fetch.spec は `test.skip(!MOQT_URI, ...)` の env-gate のみで describe.skip を使わない)。
- まず単一 FETCH の最小シナリオ (filter あり / なし) に絞り、fill fetch ストリーム (§5.1.6 / §10.2.15) の e2e は別スコープとする。

## 完了条件

- `tests/e2e/fetch.spec.ts` に FETCH の最小シナリオが存在し、`TEST_MOQT_URI` / `TEST_MOQT_AUTH_TOKEN` 設定環境で走ったときに FETCH 受信 (end 通知 + error ゼロ) を検証すること。
- 環境変数未設定時はスキップとして記録されること (暗黙の成功扱いにしない)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-20 §10.13 (FETCH。空範囲時は FETCH_HEADER + FIN)
- draft-ietf-moq-transport-20 §11.4 (Streams / FIN 時の未完成 Object)
- draft-ietf-moq-transport-20 §11.4.4.2 (End of Range)
- 関連: `issues/closed/0427-bug-data-stream-fin-incomplete-object.md`（Fetch 受信判定を合成 FIN のみで検証した旨を記載。0427 自体は draft-19 引用で書かれているが、§11.4 SHOULD は draft-20 に残存するため有効）

## 解決方法

未着手。
