# README の実装状況を実装に合わせる

- Created: 2026-09-21
- Completed: 2026-10-12
- Branch: feature/update-readme-implementation-status
- Polished: 2026-09-29

## 目的

README の「実装状況」は draft ごとの対応を網羅する形で書かれているが、実装済みの機能が載っていない。README だけを読んだ利用者が使える機能を見落とすため、実装に合わせる。

## 現状

「実装状況」に無い実装済み機能が 4 つある。いずれも `src/` に実装があることを確認した。

なお `PUBLISH_STATE_NOTIFY` (`MessageType.PUBLISH_STATE_NOTIFY`、`Publisher.notifyStateChange`、`src/publisher.ts`) は既に README の Publisher 節に記載済みであるため、本 issue の対象から除外する。

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

- README の「実装状況」に上記 4 機能と `MOQLOG` / `MOQMETRICS` が載っている
- 記載した内容が `src/` の実装と一致する
- `pnpm exec vp check` が通る

## 参照

- issues/0670-doc-sync-api-docs.md (`docs/MSF.md` 側の記載。本 issue では扱わない)
- `src/index.ts` (公開 API の一覧)
- `src/message/parameterScope.ts` / `src/session/params.ts`

## 解決方法

README.md の「実装状況」に、実装済みであるのに記載が無かった次を追記した。

- `INCLUDE_PROPERTIES` パラメータ (draft-ietf-moq-transport-22 §9.20.21。応答の OK メッセージと、SUBSCRIBE_TRACKS が生む PUBLISH に Track Properties を含めるかの指定)
- `FILL_PARAMETERS` パラメータ (§9.20.15。`SubscribeOptions.fill` で live 手前の範囲を fill fetch する)
- `TRACK_NAMESPACE_PREFIX` パラメータ (§9.20.20。namespace 系の REQUEST_UPDATE で購読する prefix を更新する)
- Parameter Scope 検証 (§9.20.1。許可パラメータ集合に無い Message Parameter を PROTOCOL_VIOLATION で拒否する)
- `MOQLOG` / `MOQMETRICS` 名前空間の公開 API (「MOQ Log / MOQ Metrics」節として追加)

同じく公開 API でありながら記載が無かった次の項目も併せて追加・更新した。

- `C4M` 名前空間の公開 API (「C4M」節)
- `AUTHORITY` / `PATH` Setup Option の受信時拒否 (INVALID_AUTHORITY / INVALID_PATH)
- `LARGEST_OBJECT` パラメータ (`Subscriber.largestLocation`)
- `LOC` 名前空間の公開 API と、Timescale / Video Config / Audio Config を Track Property としても広告できること
- Timeline の payload が無圧縮 JSON のみであること (MSF_COMPRESSION は未実装)

issue 本文が前提にしていた節番号は draft-22 の値に読み替えた。記載は `src/` の実装と `refs/` の一次資料に突き合わせ、`vp check` が通ることを確認した。`CHANGES.md` の `## develop` の `[ADD]` は、ドラフト中は変更履歴を残さない方針で削除されているため参照していない。`docs/MSF.md` 側の同期は 0670 の担当のため触れていない。
