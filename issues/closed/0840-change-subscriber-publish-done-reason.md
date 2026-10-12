# Subscriber の終了通知に PUBLISH_DONE の status code と reason を載せる

- Created: 2026-10-12
- Completed: 2026-10-12
- Branch: feature/change-subscriber-publish-done-reason
- Polished: 2026-10-12

## 目的

`Subscriber` の終了通知 (`endCallback`) は引数を持たないため、アプリは購読がなぜ終わったのかを知れない。PUBLISH_DONE の status code (draft-ietf-moq-transport-22 §12.4) は `TRACK_ENDED` / `GOING_AWAY` / `EXPIRED` / `TOO_FAR_BEHIND` / `INTERNAL_ERROR` などを区別する情報であり、moqt-devtools が購読の終了理由を表示するために必要である。`SubscriberImpl.handleEnd` は status code と reasonPhrase を受け取っているので、通知側で落とさないようにする。

## 現状

- `src/subscriber.ts` の `SubscriberImpl` は `endCallback?: (() => void)` を持ち、`handleEnd(statusCode?, reasonPhrase?)` はエラーを示す code のときだけ `errorCallback` にエラーを渡し、その後に引数なしの `endCallback` を呼ぶ
- エラーかどうかの判定は `isPublishDoneErrorStatus` による。`TRACK_ENDED` (0x2) などはエラーとみなさず、受け取った code はどこにも渡らない
- `src/session/bidi.ts` の `bidiHandlePublishDone` は `normalizePublishDoneCode` で正規化した code と reasonPhrase を `handleEnd` に渡している (§13 の Grease 対応)
- このため devtools の `trackCallbacks.end` (`devtools/src/hooks/useSubscriber.ts`) は理由を受け取れず、表示は「Stream ended」固定である
- エラー status の PUBLISH_DONE では、`handleEnd` が `errorCallback` → `endCallback` の順に呼ぶため、devtools の表示は「Subscribe error: ...」の後に「Stream ended」で上書きされる。エラーが正常終了に見える

## 設計方針

- 終了通知を、PUBLISH_DONE の status code と reasonPhrase を載せた 1 つの通知に統合する。code は `PublishDoneStatusCode` の値 (未知の code は §13 により `INTERNAL_ERROR` に正規化済み)、reason は文字列とする
- `SubscribeCallbacks.end` を `end?: (publishDone: PublishDoneInfo) => void` に変える。`PublishDoneInfo` は `statusCode: PublishDoneStatusCode` と `reasonPhrase: string` を持つ公開型として `src/session/publicTypes.ts` に置く (先例: 正常終了と異常終了を 1 通知にまとめる `SubgroupStreamEnd`)。`src/message/publish.ts` の `PublishDone` (PUBLISH_DONE のワイヤ表現。`statusCode` は `bigint`) とは別の型であるため、名前を分けて混同を避ける
- `SubscriberImpl.handleEnd` も同じ値を受け取るようにし、`bidiHandlePublishDone` が渡している `BigInt(normalizedCode)` を `normalizedCode` (number) に変える。`isPublishDoneErrorStatus` の引数は今は `bigint` だが `PublishDoneStatusCode` に変え、`PublishDoneInfo.statusCode` をそのまま渡せるようにする
- PUBLISH_DONE では `error` を呼ばない。同じ終了を二重に通知しない (今はエラー status で `error` → `end` の 2 回呼ばれる)。`error` は PUBLISH_DONE を伴わない失敗 (PUBLISH_DONE の前の FIN §6.4.2.2、RESET_STREAM、Malformed Track §12.1) の通知として残す
- `Subscriber` の公開面を更新する。`PublishDoneInfo` / `PublishDoneStatusCode` / `isPublishDoneErrorStatus` を `src/index.ts` から公開し、アプリがエラー status かどうかを名前で判定できるようにする (先例: `SubgroupStreamEnd` の `errorCode` に使う `DataStreamErrorCode` を公開した `0725-add-subgroup-reset-error-code.md`)
- `docs/LOW_LEVEL_API.md` の `### Subscriber` に購読の終了通知の節を新設する。今は `end` の記述が無いため、`end` が status code と reasonPhrase を運ぶこと、エラー status の扱い、`error` が PUBLISH_DONE を伴わない失敗専用であることを書く
- 下位互換は保たない (`CODEBASE.md` の「破壊的変更は積極的に行う」)。利用箇所は `devtools/src/hooks/useSubscriber.ts` と `src/createMediaSubscriber.ts` を確認して追従させる。`createMediaSubscriber` は購読 3 箇所すべての `end` でエラー status のときに `onError` を呼ぶ形にし、devtools は `end` で `PublishDoneInfo` を受ける。`README.md` の購読サンプルも追従する
- 理由の表示 (devtools の UI) は `0839-bug-devtools-track-end-teardown.md` で扱う。本 issue は通知までとする
- 対象外: セッション終了 (`markClosed`) の通知。今は `end` コールバックを呼ばない方針であり、これを変えない

## 完了条件

- `Subscriber` の終了通知から PUBLISH_DONE の status code と reasonPhrase が取得できる
- PUBLISH_DONE の終了では `end` が 1 回だけ呼ばれ、`error` は呼ばれない (エラー status の PUBLISH_DONE でも同じ)。`error` は PUBLISH_DONE を伴わない失敗でのみ呼ばれる
- `end` が受け取る `PublishDoneInfo` の `statusCode` が `PublishDoneStatusCode` の値であり、`reasonPhrase` が受信した文字列であることをテストで固定する
- 既存の利用箇所 (`src/createMediaSubscriber.ts` / `devtools/src/hooks/useSubscriber.ts` / `README.md` の購読サンプル) が新しい通知に追従し、`npx vp check` / `npx vp test --run` が通る
- 次のテストが新しい通知に追従する (現行の `error` → `end` の 2 回通知を固定しているため、そのままだと落ちる)
  - `src/subscriber.test.ts`
  - `src/session/bidiPublishDone.test.ts`
  - `src/session/bidi.prop.ts`
  - `src/session.test.ts`
  - `src/session/bidiReadRequestStreamMessages.test.ts`
  - `src/session/bidiSubscribeFinReset.test.ts`
  - `src/createMediaSubscriber.test.ts`

## 参照

- `0839-bug-devtools-track-end-teardown.md`
- `src/subscriber.ts` の `SubscriberImpl` (`endCallback` / `handleEnd`)
- `src/session/publicTypes.ts` の `SubscribeCallbacks` / `SubgroupStreamEnd`
- `src/message/publish.ts` の `PublishDone` (PUBLISH_DONE のワイヤ表現。新設する `PublishDoneInfo` とは別の型)
- `src/message/types.ts` の `PublishDoneStatusCode` / `isPublishDoneErrorStatus`
- `src/error.ts` の `normalizePublishDoneCode`
- `src/session/bidi.ts` の `bidiHandlePublishDone`
- `src/createMediaSubscriber.ts` の購読の `end` / `error`
- `devtools/src/hooks/useSubscriber.ts` の `trackCallbacks`
- `src/index.ts` の再エクスポート
- `docs/LOW_LEVEL_API.md` の `### Subscriber`
- `README.md` の購読サンプル
- closed の `0725-add-subgroup-reset-error-code.md` (終了通知に error code を足した先例)

## 解決方法

- `SubscribeCallbacks.end` を `end?: (publishDone: PublishDoneInfo) => void` に変え、PUBLISH_DONE の Status Code と Reason Phrase を 1 つの通知で渡すようにした。`PublishDoneInfo` は `src/session/publicTypes.ts` に置き、`src/session.ts` と `src/index.ts` から公開した
- `SubscriberImpl.handleEnd(statusCode: PublishDoneStatusCode, reasonPhrase: string)` は終了通知を 1 回だけ呼び、エラーを示す Status Code でも `error` を呼ばない (エラーかどうかは Status Code で判定する)。`error` は PUBLISH_DONE を伴わない失敗 (§6.4.2.2 の PUBLISH_DONE 前の FIN、RESET_STREAM、§12.1 の Malformed Track) と、アプリのコールバック (`object` / `datagram` / `subgroupEnd`) が throw した場合の通知として残した
- `PublishDoneStatusCode` / `isPublishDoneErrorStatus` を `src/index.ts` から公開した。`isPublishDoneErrorStatus` の引数は `PublishDoneStatusCode` に変え、§13 (Grease) に従い列挙に無い値はエラーとみなす
- `bidiHandlePublishDone` は正規化した Status Code (number) をそのまま `handleEnd` に渡すようにした
- 高レベル API (`createMediaSubscriber`) は catalog / 音声 / 映像の 3 つの購読の `end` で、エラー status のときに `onError` を呼ぶ (`resolvePublishDoneError`)。`docs/HIGH_LEVEL_API.md` の `onError` にその旨と、正常な PUBLISH_DONE では呼ばれないことを追記した
- devtools は `end` で `PublishDoneInfo` を受け取り、エラー status は error レベルのログとエラー表示にする (`resolvePublishDoneDisplay`)。catalog の購読がエラー status で終わった場合は、変更前の error コールバックと同じくその場で失敗にする。停止した購読に遅れて届いた終了もログに残す (`logPublishDoneEnd`)
- `docs/LOW_LEVEL_API.md` の `### Subscriber` に購読の終了通知の節を新設し、Status Code の判定・`error` の契約・移行時の注意を書いた。`README.md` の購読サンプルと `src/connect.ts` の JSDoc 例も追従した
- テスト: `src/message/types.test.ts` を追加し、`isPublishDoneErrorStatus` の全 9 code と列挙に無い値の分類を固定した。`src/subscriber.test.ts` / `src/session/bidiPublishDone.test.ts` / `src/session/bidi.prop.ts` / `src/session.test.ts` / `src/session/bidiReadRequestStreamMessages.test.ts` / `src/session/bidiSubscribeFinReset.test.ts` を新しい通知に追従させ、`src/createMediaSubscriber.test.ts` に catalog / 音声 / 映像の 3 経路の配線テスト、`devtools/src/hooks/useSubscriber.test.ts` に表示判定とログのテスト、`devtools/src/utils/playbackTimingStats.test.ts` に formatter のテストを追加した
- CHANGES.md は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」により更新しない
- `npx vp check` / `npx vp test --run` (3888 件) / `npx vp run e2e-test` (108 件) が通る
