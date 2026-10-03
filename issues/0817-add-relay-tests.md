# 実リレーを使った E2E テストを増やし、draft-22 の未検証経路を埋める

- Created: 2026-10-03
- Completed: {YYYY-MM-DD}
- Branch: feature/add-relay-tests
- Polished: {YYYY-MM-DD}

## 目的

実リレー (sora-moq) へ接続する E2E テストは 3 本しかなく、draft-22 で新設・再構成された経路の多くが実機で検証されていない。接続先は環境変数 `TEST_MOQT_URI` で渡す (リポジトリに URI やホストを書かない)。

## 現状

`tests/e2e/relay/` のテストは次の 3 本である。

- `connect.spec.ts`: 接続、SETUP の交換、正常切断 (`moqt-22` の ALPN)
- `fetch.spec.ts`: 絶対開始の Location Filter 付き FETCH
- `pubsub.spec.ts`: Canvas 映像の PUBLISH → リレー経由 → SUBSCRIBE (subgroup 配送、VP8 の encode / decode)

`tests/e2e/main.ts` の `window.__moqtE2E` が公開しているのは connect / publisher / subscriber / fetch の 4 系統で、namespace 系 (`publishNamespace` / `subscribeNamespace`)、`trackStatus`、`update` は公開していない。

### 試行結果 (namespace discovery)

namespace discovery のテストを試作して実リレーに対して実行した結果、次のことが分かった。

- `PUBLISH_NAMESPACE` は受理され、`NamespacePublication` は `active` になった (エラーなし)
- `SUBSCRIBE_NAMESPACE` は**応答が返らない**。送受信の記録は `send:SETUP` → `recv:SETUP` → `send:SUBSCRIBE_NAMESPACE` で止まり、15 秒待っても `REQUEST_OK` / `REQUEST_ERROR` のどちらも届かず、`subscribeNamespace()` の Promise は解決しない
- つまり現在のリレーは `SUBSCRIBE_NAMESPACE` (§9.15) に未対応である。テストをそのまま追加すると CI がタイムアウトで落ちるため、試作したテストとハーネス拡張は破棄した

## 設計方針

- 実リレーに対して**通ることを確認できたテストだけ**を追加する。リレーが未対応の経路を、スキップや緩い条件で追加しない (失敗を隠すため)
- namespace discovery は、リレーが `SUBSCRIBE_NAMESPACE` に対応してから追加する。それまでは本 issue にリレー側の要件として記録する
- 追加する経路の優先順は次のとおり。いずれも draft-22 で新設・再構成された節であり、ユニットテストでは相互接続を確認できない
  1. namespace discovery (`SUBSCRIBE_NAMESPACE` / `NAMESPACE` / `NAMESPACE_DONE`、§4.2 / §9.15〜9.17): **リレー未対応のため保留**
  2. `SUBSCRIBE_TRACKS` と `PUBLISH_SKIPPED` (§3.6 / §9.18)
  3. namespace 系 `REQUEST_UPDATE` (prefix / FORWARD、§9.5.2)。`update()` の経路は本リポジトリで最も新しい実装である
  4. `FETCH` の fill (`FILL_PARAMETERS`)、Joining FETCH 廃止後の置換経路 (§3.4)
  5. `TRACK_STATUS` (§9.12 / §9.13)
  6. Object Datagram 配送 (§11.2)。現在の pubsub テストは subgroup のみを通る
  7. `SUBSCRIBE` の `REQUEST_UPDATE` (forward / delivery timeout、§9.5)
- `tests/e2e/main.ts` に、検証したい経路の操作を追加する (connect 済みのセッションをハンドルとして保持し、コールバックで観測値を集める現在の作りに合わせる)
- 追加したテストは実リレーに対して実行して通ることを確認してからコミットする。確認できない場合はコミットせず、本 issue に結果を記録する
- テストの本数が増えると relay ジョブの所要時間も増える。1 本あたり 20〜40 秒程度を目安にし、増えすぎる場合は 1 本に複数の経路をまとめる (現在は 3 本で 2〜5 分)

## 完了条件

- 上記 2〜7 のうち、実リレーで通った経路のテストが `tests/e2e/relay/` に追加されている
- 通らなかった経路は、その結果 (どこまで進み、何が返らないか) が本 issue の解決方法に記録されている
- 追加したテストが `vp run e2e-test:relay` で通り、`timeout-minutes` (20 分) に収まる
- リポジトリのどこにも接続先 (URI / ホスト / fragment) を書いていない
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- `tests/e2e/relay/connect.spec.ts` / `fetch.spec.ts` / `pubsub.spec.ts` / `support.ts`
- `tests/e2e/main.ts` の `window.__moqtE2E`
- `.github/workflows/e2e-test.yml` (接続先は `secrets.TEST_MOQT_URI`)
- `playwright.config.ts` (`relay` プロジェクト、`timeout: 30_000`)
- `src/session.ts` の `subscribeNamespace` / `subscribeTracks` / `publishNamespace` / `trackStatus`
- draft-ietf-moq-transport-22 §3.6 / §3.4 / §4.2 / §9.5 / §9.12 / §9.13 / §9.15〜9.18 / §11.2
- 関連 issue: 0784 (実リレーへ接続する E2E テストを追加した)、0810 (namespace 系 REQUEST_UPDATE へのトークン付与)、0811 (CI の e2e ジョブのタイムアウト)

## 解決方法

{未着手}
