# PUBLISH_DONE なしの FIN で subscriber の end / error コールバックが呼ばれない

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fin-without-publish-done-not-notified
- Polished: {YYYY-MM-DD}

## 目的

Established subscription でピア (publisher) が PUBLISH_DONE を送らずに FIN した場合、subscriber へ失敗を通知する。draft-ietf-moq-transport-19 §3.3.2 の「An endpoint that receives a FIN before all required messages have arrived treats the request as failed.」に従い、この状態は失敗扱いである。現在はマップから削除されるだけで、end / error コールバックが呼ばれず state が "active" のまま残る。

なお、この文は RFC 2119 キーワード (MUST/SHOULD) を含まない平叙文であり、error 通知は仕様上の義務ではない。実際の MUST は送信側の「the publisher of an Established subscription MUST send PUBLISH_DONE, before sending a FIN」である。本 issue は「treats the request as failed」という仕様の意味論に従い、ライブラリ設計判断としてアプリへ失敗を通知するものである。

## 優先度根拠

ピアが FIN を送った時点でサブスクリプションは失敗扱いになる (§3.3.2) が、アプリケーションに通知されないため動作が不透明になる。なお、map 上のリソースリークは発生しない (bidi.ts / session.ts の両経路ともマップ削除は実行される)。問題は「アプリ可視の subscriber オブジェクトの state が "active" のまま残り、コールバックが呼ばれない」ことにある。

## 現状

- `src/session/bidi.ts:667` の `if (done) break;` でピアの FIN を検出すると読み取りループを抜け、finally ブロック (`src/session/bidi.ts:831-849`。`session.subscribers.delete` は 835、`requestStreams.delete` は 848) で `subscribers` / `subscribersByAlias` / `requestStreams` からの削除のみを行う。
- `impl.state` は "active" のまま、`end` / `error` コールバックは呼ばれない。
- 同じ問題が受信 PUBLISH ストリームの `src/session.ts:3179` (`if (done) return;`。`runPublishStreamSubLoop` 内) にも存在する。こちらは呼び出し元 (session.ts:3466-3486) でマップ削除のみが実行され、`impl.state` は "active" のまま、コールバックは呼ばれない。
- 正常経路は `bidiHandlePublishDone` (bidi.ts:1106-1132) → `subscriber.handleEnd` (subscriber.ts:283-300) が state を closed にして `endCallback` を呼ぶ。この経路には影響させない。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の FIN 検出点 + free function)、`src/session.ts` (`runPublishStreamSubLoop` の FIN 検出点)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- **対象ロールの限定**: `bidiReadRequestStreamMessages` (bidi.ts:656) は publish / subscribe 両ロール共通であり、`if (done) break;` (667) も両ロールで実行される。本 issue の対象は **subscribe ロールのみ** である。publish ロールではピア (requester / subscriber) の FIN は正常完了シグナル (§3.3.2「the requester SHOULD then send a FIN on its direction, gracefully closing the stream」) であり、失敗通知してはならない。ロール分岐は 0370 の finally ロール分岐と同じ方式 (`role === "subscribe"` ガード) で行う。
- **通知場所の限定**: 失敗通知は **FIN 検出点** (bidi.ts:667 の `break` 直前、session.ts:3179 の `return` 直前) に置き、以下の 2 条件でガードする: (a) `state === "active"`、(b) `goawayReceivedOnRequestStreams.has(requestId)` が false。finally ブロックや呼び出し元クリーンアップには置かない。finally は GOAWAY の `return` (bidi.ts:811)、PROTOCOL_VIOLATION の return、catch (RESET_STREAM 等)、while 条件によるセッション終了など全 exit 経路で実行されるため、finally に置くと (i) GOAWAY (migration 通知であり失敗ではない)、(ii) セッション close、の各経路で spurious な error 通知が発火する。
- **GOAWAY 経由のピア FIN のガード**: 0372 (重複 GOAWAY 検出) は「GOAWAY 受信後の読み取り継続」方式を採用するため、0372 実装後は「GOAWAY → その後ピアが FIN」が 0374 の FIN 検出点 (bidi.ts:667 / session.ts:3179) に合流する。GOAWAY はリクエストのマイグレーション通知であり失敗ではないため、FIN 検出点で `session.goawayReceivedOnRequestStreams.has(requestId)` を確認し、GOAWAY 受信済みの requestId では失敗通知しない (0372 の polish 済み issue も「0374 実装後の『GOAWAY 経由のピア FIN』で誤った error 通知が発火しないよう、0374 側にも注記が必要」と明記している)。現行コードでは GOAWAY 受信時に return する (bidi.ts:811 / session.ts:3205) ためこの合流は発生しないが、0372 実装後の前提としてガードを入れる。
- **通知方法**: `subscriber.handleError(new Error(...))` と `subscriber.markClosed()` の組み合わせで行う。呼び出し順は error 通知 → markClosed とする (error コールバック内から subscriber の state を参照するアプリの観測を考慮)。`handleEnd(statusCode, reasonPhrase)` は使用しない。理由: (1) `handleEnd` は statusCode のエラー判定後に必ず `endCallback` を呼び、FIN 失敗 (失敗扱い) で end を呼ぶと「正常終了」としてアプリに誤認される。(2) `endCallback` は「PUBLISH_DONE 専用」 (session.ts:2285 のコメント) であり、FIN-without-PUBLISH_DONE で呼ぶのは API 契約違反になる。(3) `handleError` は errorCallback のみで state を閉じないため、`markClosed()` との組み合わせで「error 通知 + state closed」を満たす。エラーメッセージは既存の `handleEnd` のエラー (「PUBLISH_DONE with status 0x...」) と区別可能な文言にする (例: `publisher closed request stream without PUBLISH_DONE`)。
- **free function 抽出**: `runPublishStreamSubLoop` (session.ts:3169) は private メソッドであり、セッションレベルのテストファイルも存在しないため、FIN 検出時の通知ロジックは free function (例: `notifySubscriberFin(subscriber: SubscriberImpl, error: Error): void` を `src/session/bidi.ts` に追加) として抽出し、bidi.ts:667 と session.ts:3179 の両方から呼ぶ。`session.subscribers.get(requestId)` が undefined (unsubscribe 済み等) の場合は no-op とする。テストは free function 単体 + 0370 方式の実 W3C ストリーム注入で検証する。
- **既存 catch 経路との整合**: `runPublishStreamSubLoop` の既存 catch (session.ts:3241-3252) は `impl.state === "active"` なら `callbacks.error` を呼ぶが `markClosed` しない。本 issue の FIN 検出時は「error 通知 + closed」の両方を行うため、catch 経路より厳しい要件になる。既存 catch 経路は本 issue の対象外とし変更しない (catch 経路は RESET_STREAM 等の異常で、FIN とは経路が異なる)。
- **正常経路の温存**: 正常な PUBLISH_DONE → FIN では、`bidiHandlePublishDone` が先に `subscriber.handleEnd` を呼び state を closed にするため、FIN 検出時の `state === "active"` ガードで自然に除外される。
- **0370 との相互参照**: 0370 (publish ロールの finally 保持) は同じ finally ブロック (bidi.ts:831-849) と FIN 検出点 (bidi.ts:667) を変更対象とする。0370 の「publish ロール && receivedFin フラグ」分岐は subscribe ロールの挙動を変えないため、本 issue の subscribe 側変更と干渉しない。実装順序は 0370 を先に実施し、本 issue は 0370 完了後に finally のロール分岐が入った状態で実装する。
- **0373 との相互参照**: 0373 (受信 PUBLISH の REQUEST_UPDATE 誤検知) も同じ `runPublishStreamSubLoop` を変更対象とする。変更箇所 (REQUEST_UPDATE 分岐 vs `if (done)` 分岐) は異なり機能範囲の重複はないが、相互に行番号ズレと実装順序の注記が必要である (実装順序: 0370 → 0371 → 0372 → 0373 → 0374。0372 側の「0370 → 0372 → 0374、その後 0390」に 0371 / 0373 を挿入したもので矛盾しない)。0371 による `sendRequestErrorAndCancel` の削除・移設で session.ts:3169 以降の行番号がドリフトするため、行番号は実装時に再確認する。
- **0390 との調整**: 0390 (未使用 export の非公開化) は `bidiReadRequestStreamMessages` (bidi.ts:656) を非公開化対象とする。本 issue の bidi.ts 側テストは同関数を駆動するため、0390 側に「テストで使用する `bidiReadRequestStreamMessages` の export を維持する」旨の注記が必要である (0370 と同じ調整)。0390 を先に実施するとテストが破綻するため、本 issue (0374) を先に実施する。
- **closed issue 0339 との関係**: 0339 (リクエストストリームの graceful closure) は本シナリオ (Established 後・PUBLISH_DONE 未受信の受信側 FIN を failed としてアプリ通知する強化) を「意図的に含めないもの」として先送りした。本 issue はそのフォローアップである。
- **エッジケース**: (a) セッション close 中の FIN: `markClosed` (session.ts:2287-2293) 済みのため state ガードで通知されない。(b) GOAWAY 後の FIN: 上記「GOAWAY 経由のピア FIN のガード」に従う。(c) RESET_STREAM: `reader.read()` が reject して catch に落ちる経路であり、FIN とは異なる (catch 経路は既存のまま)。(d) `handleIncomingBidirectionalStream` の先頭メッセージ読み取り (session.ts:3285) の FIN: `if (done) return;` は静かに return するため catch (3295-3298) は実行されず、`notifyErrorIfActive` は RESET 等の例外時のみ発火する (FIN では呼ばれない)。ただしこの時点では SubscriberImpl が未作成 (生成は session.ts:3407、PUBLISH デコード後) のため、通知対象もリークも存在しない。ただし、tracks 経由で Established 済みの購読がこの経路で通知なく放置される実ギャップは残余リスクとして記録する (3179 と混同しないこと)。
- **残余リスク**: (1) 既存 catch 経路 (RESET_STREAM 等) は error 通知のみで state を閉じないため、RESET_STREAM 後に state が "active" のまま残る不透明さは本 issue と同種だが、対象外とする (FIN とは経路が異なり、スコープ拡大を避ける)。(2) 上記 (d) の先頭メッセージ読み取り経路の FIN は通知されない。(3) 0372 実装後に GOAWAY → ピア FIN が合流した場合のガードは `goawayReceivedOnRequestStreams.has(requestId)` に依存するため、0372 の実装内容 (フラグの登録タイミング) と整合させる必要がある。

## 完了条件

- Established subscription (subscribe ロール) でピアが PUBLISH_DONE なしに FIN した場合、subscriber の error コールバックが呼ばれ state が closed になること。
- 受信 PUBLISH ストリーム (session.ts:3179 経路) でも同様に error コールバックが呼ばれ state が closed になること。
- publish ロールではピアの FIN で失敗通知されないこと (対象ロール限定の回帰ガード)。
- 正常な PUBLISH_DONE → FIN の経路では end コールバックが従来どおり呼ばれ、error コールバックは呼ばれないこと。
- GOAWAY 受信後の FIN では error 通知されないこと (現行コードの return 経路、および 0372 実装後の読み取り継続経路の両方。ガードは `goawayReceivedOnRequestStreams.has(requestId)`)。
- 上記を検証するテストがあること。テストは 0370 方式の実 W3C ストリーム注入 (`ReadableStream` + `WritableStream` を `as unknown as WebTransportBidirectionalStream` で注入し、`controller.close()` で FIN `{done: true}` を再現) で `bidiReadRequestStreamMessages` を subscribe ロールで駆動し、errorCallback が呼ばれることと state が closed になることを検証する (bidi.test.ts に追加。e2e は `TEST_MOQT_URI` 依存で常時実行されないため対象外)。抽出した free function の単体テストも追加する。
- 後方互換: 公開 API は変更しない。挙動変化は「PUBLISH_DONE なしの FIN で error コールバックが呼ばれ state が closed になる」の 1 点。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure / FIN はキャンセルではない / publisher は FIN 前に PUBLISH_DONE を送る MUST / FIN 前の受信は failed 扱い / requester の FIN は正常完了)
- draft-ietf-moq-transport-19 §3.3.3 (Request Cancellation and Rejection / RESET_STREAM と STOP_SENDING)
- draft-ietf-moq-transport-19 §5.1.1 (Subscription State Management / FIN 単独は終端イベントに含まれない)
- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE / 最後のメッセージとして送信)

## 解決方法

未着手。
