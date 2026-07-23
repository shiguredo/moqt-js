# リクエストストリームの Graceful Closure に追従する (draft-19 追従)

- Priority: Medium
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-graceful-request-stream-closure
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 に Section 3.3.2 (Graceful Request Stream Closure) が新設され、リクエストストリーム上の FIN と RESET_STREAM / STOP_SENDING のセマンティクスが規定された。変更履歴は Appendix A.1 `#1698` ("Define FIN vs. RST/STOP_SENDING semantics on request streams")。

draft-19 Section 3.3.2 (Graceful Request Stream Closure):

> A FIN only indicates that an endpoint will send no further messages
> in that direction; it is not a request cancellation. An endpoint
> MUST NOT send a FIN on a direction of a request stream until it has
> sent all required messages on that direction for its request type.
> In particular, an endpoint sending a response to a request MUST send
> the corresponding response message, and the publisher of an
> Established subscription MUST send PUBLISH_DONE, before sending a
> FIN. ... An endpoint that receives a FIN before all required messages
> have arrived treats the request as failed.

draft-19 Section 3.3.3 (Request Cancellation and Rejection):

> Implementations cancel a request by abruptly terminating any
> directions of the stream that are still open, using RESET_STREAM for
> a direction they are sending and STOP_SENDING for a direction they
> are receiving.

節番号の繰り下がり:

| draft-18                                 | draft-19                                     |
| ---------------------------------------- | -------------------------------------------- |
| (なし)                                   | 3.3.2 Graceful Request Stream Closure (新設) |
| 3.3.2 Request Cancellation and Rejection | 3.3.3 Request Cancellation and Rejection     |
| 3.3.3 Stream Reset Error Codes           | 3.3.4 Stream Reset Error Codes               |

## 優先度根拠

正常終了パス（`sendPublishDone`）の PUBLISH_DONE → FIN は既に実装されている（closed `#0323`）。一方、(1) 応答前 FIN を失敗扱いにしない namespace 系ループ、(2) `session.close()` が Established publisher のリクエストストリームに PUBLISH_DONE 無しで FIN しうる点は Section 3.3.2 MUST と衝突し得る。準拠ギャップの修正と回帰テストのため Medium。

## 現状

シンボル名を正とする。

### 既に整合しているもの

- `sendPublishDone`（`src/session.ts`）: リクエスト bidi に PUBLISH_DONE を `writer.write` したあと `writer.close()`（FIN）。Section 3.3.2 / 10.11 の順序は満たす（closed `#0323` で追加）
- `PublisherImpl.onDoneInternal`（`session.ts` の `publish()` 結線）: 先に `closePublisherStream`（**データ**ストリーム閉鎖。Section 10.11 の「PUBLISH_DONE 前にデータストリームを閉じる」）、続けて `sendPublishDone`。コメントの「まずストリームを閉じる（FIN を送信）」は **誤解を招く**（リクエストストリームの FIN ではない）
- `bidiReadPublishResponse` / `bidiReadSubscribeResponse` / `bidiReadFetchResponse` / `bidiReadTrackStatusResponse`（`src/session/bidi.ts`）: 応答前に readable が `done` なら throw / reject（失敗扱い）。Section 3.3.2 の「required messages 前の FIN = failed」に整合
- `bidiCancelSubscription` / `bidiCancelFetch`: `readable.cancel()`（STOP_SENDING 相当）+ `writer.abort()`（RESET_STREAM 相当）。Section 3.3.3 に整合。本 issue で仕様変更は不要

### ギャップ

1. **`startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop`**: readable が `done`（FIN）で `break` したとき、`resolved === false` でも Promise を reject せず `finally` で消える。await 中の呼び出しが宙吊りになり、Section 3.3.2 の「required messages 前の FIN = failed」を満たさない
2. **`session.close()`**: 保持中の request stream writer に対し `writer.close()`（FIN）する。Established publisher について PUBLISH_DONE 無しの FIN になり得る（Section 3.3.2 MUST 違反の可能性）。セッション解体は abrupt 終了が自然なら `abort`（RESET）に寄せる判断が必要
3. **回帰テスト不足**: PUBLISH_DONE → FIN の順序を固定するテストが無い（実装はある）
4. **コメント**: `onDoneInternal` の誤記、および触るファイルの draft-18 §3.3.x 参照。リポジトリ全体の一掃は `#0343`

## 設計方針

### 本 issue の範囲

1. namespace / tracks / publishNamespace の 3 ループで、応答前（`!resolved`）に FIN（`done`）を検出したら Promise を reject する（エラーメッセージは英語ログ規約に従いコード側は英語）。セッション全体は閉じない（リクエスト失敗）
2. `session.close()` で Established な publisher リクエストストリームを閉じるとき、PUBLISH_DONE 無しの FIN を避ける。方針は次のいずれか（実装時に一方を選ぶ。推奨は A）
   - **A（推奨）**: 当該 writer は `close()` せず `abort()`（RESET 相当）にする。セッション解体は graceful request completion ではない
   - **B**: 各 publisher に `sendPublishDone` してから FIN。ただし close 中の例外・順序が重い
3. `sendPublishDone` の PUBLISH_DONE → FIN 順序を、エンコード結果または writer 操作順が検証できるテストで固定する（モック禁止。`WritableStream` 実体で write/close 順を記録する等）
4. `onDoneInternal` の誤コメントを「データストリーム閉鎖 → PUBLISH_DONE → リクエスト FIN」に直す。触ったファイルの 3.3.x 参照だけ draft-19 に更新

### 意図的に含めないもの

- Section 3.3.3 キャンセル実装の作り直し（既存で充足）
- Established 後・PUBLISH_DONE 未受信の受信側 FIN を「failed」としてアプリ通知する強化（`bidiReadRequestStreamMessages` / `runPublishStreamSubLoop` の `done` で掃除のみ）。応答前 FIN の失敗扱いは本 issue の対象。Established 後は既存の end/error 経路に委ねる
- `#0337` の unexpected REQUEST_UPDATE / 10.9.1 NS 失敗時 close
- `#0343` による draft-18 コメント一括更新
- データストリーム（Subgroup）上の FIN / RESET_STREAM_AT（Section 11 系。本 issue はリクエスト bidi）

### テスト戦略（モック禁止）

- PUBLISH_DONE → FIN: `sendPublishDone` が使う writer を実 `WritableStream` で差し替え可能なら、write ペイロードに PUBLISH_DONE 型が載ったあと close が呼ばれる順を assert。難しければ encode + 順序を保証するヘルパー抽出をテスト
- 応答前 FIN: `startNamespaceStreamLoop` 等は private のため、制御メッセージ無しで readable を閉じたときに subscribeNamespace Promise が reject される経路を、テスト用に露出したヘルパーか、ループ内の「`done && !resolved` → reject」を純粋判定に切り出して単体テストする。WebTransport モックは禁止

## 完了条件

- `sendPublishDone` が PUBLISH_DONE のあと FIN する順序のテストがあること
- `startNamespaceStreamLoop` / `startTracksStreamLoop` / `startNamespacePublicationStreamLoop` で応答前 FIN 時に Promise が reject されること（テストまたは切り出し単体で確認）
- `session.close()` が Established publisher に PUBLISH_DONE 無し FIN を送らないこと（方針 A なら abort、B なら PUBLISH_DONE 後 FIN）
- 3.3.3 キャンセル経路（`bidiCancelSubscription` / `bidiCancelFetch`）を本変更で壊していないこと
- `CHANGES.md` の `## develop` にエントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/session.ts` の 3 ループ: `if (done) { if (!resolved) reject(...); break; }`（文言は実装時に統一）
2. `src/session.ts` `session.close()`: request stream writer の閉じ方を方針 A または B に変更。publisher 以外（subscriber 側ストリーム等）も FIN が「応答完了前」にならないか確認し、未完了なら abort に寄せる
3. `onDoneInternal` コメント修正。`sendPublishDone` の仕様参照を draft-19 Section 3.3.2 / 10.11 に更新
4. テスト追加（上記戦略）。モック禁止
5. `CHANGES.md` の `## develop` に `[FIX]` または `[CHANGE]` で追記する
