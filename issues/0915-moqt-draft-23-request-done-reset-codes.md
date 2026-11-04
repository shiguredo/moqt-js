# REQUEST_ERROR と PUBLISH_DONE と reset の登録コードを同期する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §12.3〜§12.5 は UNAVAILABLE を追加し、PUBLISH_DONE に EXPIRED_AUTH_TOKEN を追加し、PREFIX_OVERLAP と UNKNOWN_OBJECT_STATUS を削除した。現在の normalizer は新しい理由を INTERNAL_ERROR にし、削除されたコードを既知とする。

## 現状

- `src/error.ts` の `RequestErrorCode` は UNAVAILABLE を持たず、PREFIX_OVERLAP (0x30) を残す
- `src/message/types.ts` の `PublishDoneStatusCode` に EXPIRED_AUTH_TOKEN (0x07) が無い
- `src/error.ts` の `DataStreamErrorCode` は UNKNOWN_OBJECT_STATUS (0x06) を残す
- 各 normalizer は上記定数から既知集合を作り、`src/session/bidi.ts` の `getDataStreamErrorCodeName` にも旧名がある

## 設計方針

- REQUEST_ERROR の UNAVAILABLE (0x0A) と PUBLISH_DONE の EXPIRED_AUTH_TOKEN (0x07) を定義し、公開型・codec・通知へ保持する
- PREFIX_OVERLAP と UNKNOWN_OBJECT_STATUS を定数・既知集合・説明から除く。受信時は §13 の未知コードとして扱う
- EXPIRED_AUTH_TOKEN は Session / Request / PUBLISH_DONE / reset で異なる文脈を持つ。同じ名前だからと共通の数値・normalizer を使わない
- UNAVAILABLE の Retry Interval を失わずアプリへ渡す。クライアントに relay の stream credit 管理を追加しない
- 公開 `Publisher.done` に任意の status 引数を追加し、許可する値を TRACK_ENDED と EXPIRED_AUTH_TOKEN にする。省略時は従来どおり TRACK_ENDED、`done(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN)` は 0x07 を送る。許可外の値は状態変更より前に拒否し、実際の終了は既存の PublisherImpl.terminate に委譲して、排他・重複呼出し・送信と cleanup の契約を保つ。トークンの有効期限を自動検証する認可サーバーは追加しない
- 0906 の overlap 削除、0899 の Unknown Range 継続と矛盾する旧記述を取り除く。セッション終了コードは 0902 が担当する

## 完了条件

- 新 2 コードが codec、normalizer、RequestError / PUBLISH_DONE 通知まで保持される
- 削除された 0x30 / 0x06 と GREASE はそれぞれの文脈で INTERNAL_ERROR と同等に扱われる
- 既存の EXPIRED_AUTH_TOKEN 各コードを混同しない
- 新 status を持つ正常な PUBLISH_DONE で不要な Session エラーにしない
- 公開 Publisher 型の done から 0x07 が送信され、引数省略時の TRACK_ENDED と既存の終了・cleanup が維持される。許可外 status は副作用前に拒否される

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §7.4 / §9.9 / §12.3〜§12.5 / §13 / §16.12
- `src/error.ts`、`src/message/types.ts`、`src/message/publish.ts`、`src/session/bidi.ts`、`src/session/publish.ts`
- `src/publisher.ts` の `Publisher.done` / `PublisherImpl.done` / `PublisherImpl.terminate`、公開 API 文書

## 解決方法

- `src/error.ts` の `RequestErrorCode` に UNAVAILABLE (0x0A) を追加し、PREFIX_OVERLAP (0x30) を削除した。`DataStreamErrorCode` から UNKNOWN_OBJECT_STATUS (0x6) を削除した。JSDoc を §12.3〜§12.5 / §13 に同期している。
- `src/message/types.ts` の `PublishDoneStatusCode` に EXPIRED_AUTH_TOKEN (0x07) を追加し、`isPublishDoneErrorStatus` でエラー終了として扱うようにした。EXPIRED_AUTH_TOKEN は Session (0x18) / Request (0x5) / PUBLISH_DONE (0x7) / Stream Reset (0x7) で別のコード空間を持つため、同名でも共通の数値・normalizer を使わないことを JSDoc に明記した。
- 削除したコードは定数・既知集合・説明から除き、受信時は §13 の未知コードとして INTERNAL_ERROR に正規化する。
- REQUEST_ERROR の UNAVAILABLE は既存の `buildRequestErrorFromDecoded` が Retry Interval を渡す構造のため、既知コード化だけでアプリまで保持される (1500 ms の保持をテストで確認)。relay の stream credit 管理は追加していない。
- 公開 `Publisher.done(status?: PublishDoneStatusCode)` に status 引数を追加した。省略時は従来どおり TRACK_ENDED、`done(PublishDoneStatusCode.EXPIRED_AUTH_TOKEN)` は 0x07 を送信する。許可外の status は `onDoneInternal` と状態変更より前に throw し、実際の終了は既存の `terminate` に委譲して排他・重複呼出し・送信と cleanup の契約を保つ。トークンの有効期限を自動検証する認可サーバーは追加していない。
- 0906 の overlap 削除と 0899 の Unknown Range 継続に矛盾する旧記述を除去した (`namespaceLoops.test.ts` / `namespaceLoops.prop.ts` の旧定数参照を INTERNAL_ERROR へ置換)。
- テストは UNAVAILABLE の保持と Retry Interval、削除コードと GREASE の INTERNAL_ERROR 正規化、各文脈の EXPIRED_AUTH_TOKEN の非混同、`isPublishDoneErrorStatus`、PUBLISH_DONE の EXPIRED_AUTH_TOKEN の codec 保持と終了通知への伝搬、`Publisher.done` の省略 / EXPIRED_AUTH_TOKEN / 許可外 status の拒否と拒否後の通常動作を検証する。
- 検証中に PUBLISH の PBT が既知 Property の重複を生成して flake する問題を発見したため、`src/message/parameterArb.ts` の Track scope arbitrary に重複フィルタを追加した (0914 の重複検証と整合)。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限

- `docs/` の公開 API 文書 (`Publisher.done` の status 引数) 更新は 0925 で行う。
- セッション終了コード (§12.2) は 0902 の担当範囲のため変更していない。
- PUBLISH_DONE の送信 status 制限は公開 `done` のみに適用し、セッション内部の `terminate` (UPDATE_FAILED など) の既存契約は維持している。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
