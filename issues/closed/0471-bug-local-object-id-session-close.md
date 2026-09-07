# ローカルの不正 objectId でセッションを閉じてしまう

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-local-object-id-validation
- Polished: 2026-09-06

## 目的

アプリの API 誤用 (範囲外 `objectId`) は fail-fast で呼び出し元に返すべきである。現状はセッション全体を閉じるうえ、呼び出し元の `Promise` は `resolve` して失敗が観測できない。§11.4.2 の `endpoint MUST close` は不正ワイヤ受信時の規定であり、送信前のローカル検証の方法までは定めない。意図的決定の `0323` を覆し、`throw` 化するために修正が必要である。

## 現状

- `src/session/publish.ts` の `publishSendObjectInternal` は `objectId` の範囲外を `session.closeWithError` (`PROTOCOL_VIOLATION`) して `return` する。これは `0323` の意図的決定どおりの動作である。
- `0323` は「単に throw すると `sendObject` の `.catch()` → `publisher.handleError()` に流れてセッション閉鎖に至らないため」close を選んだ。すなわち `throw` 化にはキューチェーンの吸収の見直しが必須であり、本 issue はその対応を含む。
- `§11.4.2` の文面の主体は受信側限定でない `the endpoint` であり、「受信側の義務」とは断定しない。不正 `objectId` がローカル API 誤用である点が `throw` 化の根拠である。
- 検証がストリーム生成 (新規 `Group` 時の開設・前ストリーム `FIN`・統計加算) の後にあるため、不正時も副作用が残る。`groupId` 検証は副作用回避のため前倒し済みであり、非対称である。

## 設計方針

1. `objectId` 範囲検証をストリーム生成前 (`groupId` 検証と同位置) に前倒し、不正時は `throw` (英語メッセージ、期待値と実際値を含む) に変更する。
2. `throw` がキューチェーンの `.catch()` (`publisher.handleError()` への変換) に吸収されず、公開 `sendObject` の返値 `Promise` が `reject` するよう伝播方式を見直す。既存の error 通知契約との整合を保つ。
3. 境界値の単体テストを追加する。到達可能な値に限定する (`0` / `-1` / 超過の `2^64`。`2^64-1` は `number` で正確に表現できないため対象外)。不正時はストリーム未生成であることも検証する。

## 完了条件

- 不正 `objectId` で公開 `sendObject` の返値 `Promise` が `reject` し、セッションが閉じないこと。不正かつ新規 `Group` の場合もストリームが生成されないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.2
- `0323` (現行動作の意図的決定。本 issue は `.catch()` 吸収への対応を含めて覆す)

## 解決方法

- `src/session/publish.ts` に ID 値域検証ヘルパーを新設し、公開 sendObject の先頭で groupId / objectId を fail-fast 検証する（通知 + 返値の reject、キュー未登録）。内部実装も lookup・FIN より前で再検証し、旧 closeWithError 経路を除去した
- groupId も同一契約に揃え、datagram 経路は通知 + throw、エンコード失敗も通知契約に揃えた。公開 sendObject / sendDatagram の JSDoc に契約を記載した
- `src/session/publish.test.ts` に境界値等のテスト 9 件を追加した。旧挙動の 4 件は新挙動で落ちることを確認した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
