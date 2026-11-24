# 正常な PUBLISH_DONE で catalog の受信待ちが解放されず受信タイムアウトで失敗する

- Created: 2026-11-25
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-normal-publish-done-wait
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE) は、購読の終了の理由を §12.4 の Status Code が表すと定める。`TRACK_ENDED` / `GOING_AWAY` / `EXPIRED` は正常終了であり、エラーではない。

高レベル API の catalog の購読が正常終了の PUBLISH_DONE で終わっても、`CatalogSubscription.subscribe` の受信待ちが解放されない。そのため `start()` は購読が正常に終わっているのに 5000 ms 待たされ、最後に `catalog receive timeout` という誤った理由で失敗する。フル catalog を既に受信していても、その catalog を捨てて失敗する。

0843 (catalog 購読がエラー status の PUBLISH_DONE で終わっても待ちが解放されず、通知が二重になる) はエラー status の経路だけを直し、正常終了は「残した課題」として対象外にした。0842 (高レベル API で正常な PUBLISH_DONE を検知できない) は `onPublishDone` の追加であり、待ちの解放は明示的に対象外としている。本 issue はその残した課題を扱う。

## 現状

- `src/mediaSubscriber/catalogSubscription.ts` の `subscribe` が `session.subscribe` に渡す `end` は、正常終了 (エラーを示さない Status Code) では `handlePublishDone` を呼ぶだけで、`catalogResolve` / `catalogReject` に触れない
- 受信待ちを作る前の終了 (SUBSCRIBE_OK と同じチャンクで PUBLISH_DONE が届く場合) は、エラー status のときだけ `publishDoneBeforeWait` に記録し、正常終了では何もしない。そのため受信タイマーが作られ、満了まで待つ
- 受信待ちは `tryResolveCatalog` (フル catalog の適用時)、`rejectCatalogReceive` (受信タイムアウト)、`abortReceive` (解放) でしか決着しない。PUBLISH_DONE はどの契機にもなっていない
- 待ちを作らないまま `catalogReceiveFailed` も立たないため、購読が終わったあとに届く Object は適用され続ける (無害だが、終了済みの購読として扱われていない)

### 実測 (2026-11-25、`subscribeCatalog` を受信タイムアウト 200 ms で駆動)

| 場面                                                                | 結果                                                    | 待ち時間                  |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------- |
| 待ちの間の正常終了 (`TRACK_ENDED`)                                  | `catalog receive timeout` で失敗                        | 202 ms (タイマー満了まで) |
| 待ちを作る前の正常終了 (`TRACK_ENDED`、SUBSCRIBE_OK と同一チャンク) | `catalog receive timeout` で失敗                        | 200 ms (タイマー満了まで) |
| FETCH フェーズ中にフル catalog をバッファ済みで正常終了             | `catalog receive timeout` で失敗し、`onCatalog` は 0 回 | 202 ms (タイマー満了まで) |

3 行目は、受信済みの完全な catalog を捨てたうえで、実際には正常に終わった購読を失敗として扱う。`start()` は「catalog が届かなかった」と報告するが、実際は届いていた。

## 再現手順

コードの経路で確かめた。実 relay での再現は行っていない。

1. `createMediaSubscriber` で購読を開始する
2. publisher が catalog の SUBSCRIBE_OK の直後に `TRACK_ENDED` の PUBLISH_DONE を送る (catalog を 1 度も送らないで終える場合や、publisher が直後に停止した場合)
3. `start()` が 5000 ms 待った末に `catalog receive timeout` で失敗する

## 設計方針

正常終了の PUBLISH_DONE も、0843 がエラー status に対して決めた待ちの状態ごとの扱いに揃える。契機が「エラー status」か「正常終了」かだけが異なる。

- 待ちを作る前の正常終了: 待ちも FETCH も作らずに失敗する。受信タイマーも作らない。購読は `catalogSubscriber` に代入済みであり、`start()` の巻き戻しが解除する
- 待ちの間の正常終了: FETCH の応答を待たずに `finishCatalogFetchPhase` でドレインする。ドレインでフル catalog を resolve できたら起動を続け、`handlePublishDone` で通知する。できなければ待ちを reject する (起動を失敗させる)
- 待ちが決着した後の正常終了: 従来どおり `handlePublishDone` で通知するだけ (起動は失敗させない)
- いずれの経路でも、`catalogReceiveSettled` を resolve / reject の呼び出し時点で立てる現在の判定をそのまま使う。正常終了は `resolvePublishDoneError` が null を返すため、エラー status と同じ分岐に載せるには「エラー status か正常終了か」ではなく「決着できるか」で分ける形に組み替える
- 待ちを reject するときの Error は、`resolvePublishDoneError` では作れない (正常終了で null を返すため)。正常終了用の Error を作る関数を `catalogSubscription.ts` に置き、`catalog receive timeout` を名乗らせない。文言は「購読が正常に終わったが catalog が揃わなかった」ことを示す形にする (例: `catalog ended without a full catalog: PUBLISH_DONE with status 0x{code}`)。0843 がエラー status に使う `PUBLISH_DONE with status 0x{code}: {reason}` と同じ形の情報 (Status Code と Reason Phrase) を含める
- `onError` の扱いは 0843 と同じにする。`end` からは通知せず、失敗した場合は `start()` の失敗経路が 1 回だけ通知する。ドレイン中の `onCatalog` の例外は `reportCallbackError` で通知する (二重になるが契機が異なる)
- 0842 の `onPublishDone` を追加する際は、本 issue の経路でも購読の正常終了として 1 回通知する。待ちを reject して `start()` を失敗させる場合でも、購読そのものは正常終了であるため `onPublishDone` の対象になる。0842 との順序と回数は、0842 の実装時に本 issue のテストで固定した回数を基準にする
- 対象は `src/mediaSubscriber/catalogSubscription.ts` / `src/createMediaSubscriber.publish-done.test.ts` / `docs/HIGH_LEVEL_API.md` とする
- `CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従い更新しない

## 完了条件

- 待ちを作る前の正常終了で、待ちも受信タイマーも FETCH も作らずに PUBLISH_DONE 由来の Error で失敗する (`catalog receive timeout` を名乗らない)
- 待ちの間の正常終了で、FETCH の応答を待たずにドレインし、フル catalog があれば `start()` が成功して `onCatalog` が発火する。無ければ PUBLISH_DONE 由来の Error で失敗する
- 待ちが決着した後の正常終了では `start()` が失敗せず、通知も増えない
- 上記のいずれでも受信タイマーを待たない (実測で 200 ms のタイマーを使い、タイマー満了より先に決着することを確かめる)
- `onError` は失敗の経路で 1 回だけ呼ばれる (0842 の `onPublishDone` を実装した後は、それと合わせて購読ごとに 1 回の終了通知になる)
- `src/createMediaSubscriber.publish-done.test.ts` に、上記の 3 経路を固定するテストがある
- `docs/HIGH_LEVEL_API.md` の `### カタログの受信` に、正常終了の PUBLISH_DONE の扱いを書く
- `npx vp check` / `npx vp exec tsc --noEmit` / `npx vp test run` が通る

## 参照

- draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE。Status Code が終了の理由とエラーの有無を表す) / §12.4 (Publish Done Codes。`TRACK_ENDED` / `GOING_AWAY` / `EXPIRED` が正常終了)。`refs/moq/draft-ietf-moq-transport-23.txt`
- `src/mediaSubscriber/catalogSubscription.ts` の `subscribe` (`end` の分岐) / `finishCatalogFetchPhase` / `resolvePublishDoneError` (依存として注入) / `tryResolveCatalog` / `rejectCatalogReceive`
- `src/createMediaSubscriber.ts` の `handlePublishDone` / `resolvePublishDoneError` / `start` の失敗経路
- `src/message/types.ts` の `isPublishDoneErrorStatus` (正常終了の判定)
- `src/createMediaSubscriber.publish-done.test.ts` の 0843 で追加した 3 経路のテスト
- open の `0842-add-media-subscriber-normal-end.md` (正常な PUBLISH_DONE の通知。待ちの解放は明示的に対象外) / `0836-bug-catalog-drain-error-handling.md` (ドレイン中の `onCatalog` の例外の扱いを経路ごとに揃える)
- closed の `0843` 系の 3 つの PR (`0843` 本体・1 周目の指摘・2 周目の指摘。catalog の PUBLISH_DONE の扱いを待ちの状態ごとに分けた)
- closed の `0133-bug-catalog-receive-timeout-race.md` / `0755-bug-media-subscriber-catalog-timeout-devtools-publisher.md` (catalog が届かない別の問題。本 issue は「届いたが正常終了した」場合であり重複しない)

## 解決方法

{未着手}
