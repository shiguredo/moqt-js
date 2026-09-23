# README の実装状況を実装に合わせる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/update-readme-implementation-status
- Polished: {YYYY-MM-DD}

## 目的

README の「実装状況」は draft ごとの対応を網羅する形で書かれているが、実装済みの機能が載っていない。README だけを読んだ利用者が使える機能を見落とすため、実装に合わせる。

## 現状

「実装状況」に無い実装済み機能が 5 つある。いずれも `src/` に実装があることを確認した。

- `PUBLISH_STATE_NOTIFY` (`MessageType.PUBLISH_STATE_NOTIFY`、`Publisher.notifyStateChange`、`src/publisher.ts`)
- `INCLUDE_PROPERTIES` パラメータ (draft-21 §9.20.22、`src/session/params.ts` の `buildIncludePropertiesParameter` が構築し、`buildSubscribeParameters` / `buildFetchParameters` / `buildSubscribeTracksParameters` / `buildTrackStatusParameters` が載せる)
- `FILL_PARAMETERS` パラメータ (draft-21 §9.20.16、`SubscribeOptions.fill` から `src/session/params.ts` の `buildFillParameters` が構築する)
- `TRACK_NAMESPACE_PREFIX` パラメータ (draft-21 §9.20.21、`src/message/parameter/trackNamespace.ts` の `encodeParameterTrackNamespace` が送信し、`src/message/parameter/messageParameter.ts` が受信時に §8.7 の Track Namespace として復号する)
- Parameter Scope 検証 (`src/message/parameterScope.ts` の `validateParameterScope` / `assertParametersAllowedForSend`)

また `MOQLOG` / `MOQMETRICS` は `src/index.ts` が `export * as` で公開しているが、README の実装状況に記載が無い。README の `packaging: loc / mediatimeline / eventtimeline / moqlog / moqmetrics` は Catalog のフィールド値の列挙であり、公開 API の説明ではない。

## 設計方針

- README の「実装状況」に上記を追記する。既存の節構成 (Publisher / Subscriber / コントロールメッセージ / データストリーム / MOQT Streaming Format) のうち適切な節に置く
- `MOQLOG` / `MOQMETRICS` は README 側だけを直す。`docs/MSF.md` は 0670 で扱う
- README は網羅を主張しているため、追記漏れを残さない。追記するだけで実装の変更は行わない

## 完了条件

- README の「実装状況」に上記 5 機能と `MOQLOG` / `MOQMETRICS` が載っている
- 記載した内容が `src/` の実装と一致する
- `pnpm exec vp check` が通る

## 参照

- issues/0670-doc-sync-api-docs.md (`docs/MSF.md` 側の記載。本 issue では扱わない)
- `src/index.ts` (公開 API の一覧)
- `src/message/parameterScope.ts` / `src/session/params.ts`

## 解決方法

{未着手}
