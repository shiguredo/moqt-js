# REQUEST_ERROR と PUBLISH_DONE と reset の登録コードを同期する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-request-done-reset-codes
- Polished: {YYYY-MM-DD}

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
- publisher が明示的に token expiry で購読を終了するときは新しい PUBLISH_DONE status を使えるようにする。トークンの有効期限を自動検証する認可サーバーは追加しない
- 0906 の overlap 削除、0899 の Unknown Range 継続と矛盾する旧記述を取り除く。セッション終了コードは 0902 が担当する

## 完了条件

- 新 2 コードが codec、normalizer、RequestError / PUBLISH_DONE 通知まで保持される
- 削除された 0x30 / 0x06 と GREASE はそれぞれの文脈で INTERNAL_ERROR と同等に扱われる
- 既存の EXPIRED_AUTH_TOKEN 各コードを混同しない
- 新 status を持つ正常な PUBLISH_DONE で不要な Session エラーにしない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §7.4 / §9.9 / §12.3〜§12.5 / §13 / §16.12
- `src/error.ts`、`src/message/types.ts`、`src/message/publish.ts`、`src/session/bidi.ts`、`src/session/publish.ts`

## 解決方法

{未着手}
