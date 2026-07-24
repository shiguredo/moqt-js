# MOQT_IMPLEMENTATION のセキュリティ考慮

- Priority: Low
- Created: 2026-03-16
- Completed: YYYY-MM-DD
- Model: manual
- Branch: feature/change-moqt-implementation-opt-out
- Polished: YYYY-MM-DD

## 概要

MOQT_IMPLEMENTATION Setup Option のセキュリティ・プライバシー考慮事項を追加する。

## 参照

- draft-ietf-moq-transport-17 Section 13
- https://github.com/moq-wg/moq-transport/pull/1511

## 変更内容

- draft-17 で MOQT_IMPLEMENTATION Setup Option によるフィンガープリンティングのリスクに関するセキュリティ考慮事項が追加された
- 実装バージョンを公開することのプライバシーリスクが指摘された

## 影響範囲

- `src/message/setup.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 13 のセキュリティ考慮事項を確認する
2. MOQT_IMPLEMENTATION の送信をオプションにする、または無効化可能にする
3. 必要に応じてドキュメントコメントを追加する

## pending 理由

MOQT_IMPLEMENTATION の送信をオプション化する独自機能の追加が必要。設計判断が必要（デフォルトで送信するか否か、API 設計など）。

## 調査結果

**未解決であることを確認**

- `src/message/setup.ts` の `createSetup()` は `PATH` / `AUTHORIZATION_TOKEN` / `AUTHORITY` の後に `MOQT_IMPLEMENTATION` を必ず追加している。送信を無効化する分岐は存在しない。
- `src/session.ts` の `initialize()` は常に `createSetup()` を呼んで `SETUP` を送信しており、`MOQT_IMPLEMENTATION` だけを抑止する option は持っていない。
- `src/version.ts` では `MOQT_IMPLEMENTATION_VALUE = \`moqt-js/${version}\`` を公開しており、現在の既定挙動は実装名とバージョンをそのまま相手へ送るものである。
- `src/message/setup.test.ts` でも「MOQT_IMPLEMENTATION は常に追加される」前提でテストしているため、仕様変更ではなく API 変更として扱う必要がある。
- 以上から、フィンガープリンティング懸念に関する issue の問題提起は現在も有効であり、まだ対処されていない。

## 今どうするべきか

- 現状の実装ではこの issue は未解決のままである。
- ただし単純に送信を止めるのではなく、`ConnectOptions` か `createSetup()` のどちらで opt-out / override を持たせるかを先に決めるべきである。
- プライバシー要件が明確になるまでは `issues/pending/` のまま維持し、設計判断が固まってから着手するのが妥当である。

## 状況確認 (2026-04-29)

- `src/message/setup.ts:69-74` を再確認。`createSetup()` は依然として `MOQT_IMPLEMENTATION` を無条件で push しており、opt-out / override の分岐は追加されていない。
- `src/version.ts:13` の `MOQT_IMPLEMENTATION_VALUE = \`moqt-js/${version}\`` も変更なし。送信値は実装名 + バージョンそのまま。
- 設計判断 (どこで opt-out させるか) も未決定のまま。pending 維持で変更なし。

## reopened にする理由

draft-ietf-moq-transport-19 §13.8 がプライバシー緩和を具体化したため着手可能になった。

- Implementations SHOULD send only the minimum information necessary
- Privacy-conscious deployments MAY omit the option entirely or send a generic value
- Implementations MAY provide users with the ability to configure or disable the option

設計方針は draft-19 に合わせて次で固定する。既定は現状どおり送信を維持し、`ConnectOptions`（または同等）で opt-out / override を提供する。参照節は Section 13.8 / §10.3.1.5 に更新する。
