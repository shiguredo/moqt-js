# Subscriber を SessionMachine 駆動に置き換える

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

`src/subscriber.ts` の `Subscriber` は現在、`subscriberState` / `subscriberLargestLocation` / `subscriberTrackProperties` を自前で保持し、`session.ts` からの setter (`setTrackProperties` / `setLargestLocation` / `handleEnd`) 呼び出しによって状態が更新されている。
`Session` (`src/session/session.ts`) は SessionMachine の `subscribeOkReceived` / `publishDoneReceived` / `objectReceived` 等のイベントを受けたあとに Subscriber のメソッドを呼ぶルーティングを手書きしており、#0081 で扱う Publisher と同じ構造的重複を抱えている。

`SessionMachine` 側は SUBSCRIBE / FETCH / subscription entry を既に内部で持っているため、Subscriber はそれを射影する facade にして `session.ts` のグルーコードを削減する。本 issue は #0081 (Publisher) の同型リファクタリングを Subscriber に適用する。

## 背景

- #0073 で sans-I/O な `SessionMachine` を導入し、SUBSCRIBE / FETCH / subscription state を内部で完全管理している
- #0077 で Session 受信経路を SessionMachine に流し込む構造になったが、Subscriber 関連の setter ルーティングが `session.ts` に残っている
- Subscriber は state を独自に保持しており、SessionMachine の state と二重管理

## 方針

1. **Subscriber の state を SessionMachine 由来の射影にする**
   - `Subscriber.state` / `largestLocation` / `trackProperties` は SessionMachine の subscription エントリから都度 derive する
   - local フィールドを撤去する
2. **Subscriber が SessionMachine のイベントを subscribe する**
   - `Session` が手書きしている `handleSubscribeOk` / `handlePublishDone` / `handleObjectReceived` 相当のルーティングを Subscriber 側で受け取る
   - `session.ts` から Subscriber 関連の setter / cleanup 呼び出しを削除する
3. **SessionMachine 側の view API 拡充**
   - `getSubscriptionView(requestId)` 相当の read-only view を追加する
   - 足りなければ本 issue 内で SessionMachine 側にも API を足す
4. **I/O は引き続き Session が担当**
   - Object / Datagram のデコードなどは Session の callback (`onObject` など) で受け、Subscriber に forward する構造は維持
   - Subscriber は「状態の facade + 受信 callback の shim」になる

## 影響範囲

- `src/subscriber.ts` (約 289 行) の大幅書き換え
- `src/session/session.ts` の Subscriber 関連ルーティング削除
- `src/session/machine.ts` に Subscriber 向けの view API 追加
- `src/subscriber.test.ts` / `src/subscriber.prop.ts` の更新
- `CHANGES.md` に `[CHANGE]` として記載 (公開 API に破壊的変更あり)

## リスク

| ID  | リスク                                                                    | 緩和                                                                        |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| R1  | Subscriber の状態取得が object 受信毎のホットパスで SessionMachine を叩く | view lookup は O(1) Map、イベント購読はキャッシュする                       |
| R2  | SUBSCRIBE_DONE / PUBLISH_DONE 受信時の cleanup 順序が変わりリークが発生   | SessionMachine の `subscriptionTerminated` イベントに終了ロジックを集約する |
| R3  | 既存テスト (property test 含む) が `setTrackProperties` 等を直接呼ぶ      | テストを SessionMachine feed → Subscriber view assert に先に書き換える      |

## 段階的な進め方

1. Phase 1: SessionMachine に Subscriber 向けの view API (`getSubscriptionView(requestId)`) を追加し、PBT を書く
2. Phase 2: Subscriber を view 参照型に書き換え、local state を撤去する。テストを先に書き換える
3. Phase 3: `session.ts` の Subscriber 関連ルーティングを削除し、event 購読に置き換える
4. Phase 4: CHANGES.md 更新、typecheck / test / build 緑を確認する

各 Phase を 1 コミットとする。

## 前提

- #0081 の成果物 (Publisher を SessionMachine 駆動にする過程で確立する view API パターン) を踏襲する
- #0081 が close されてから本 issue に着手する

## 参考

- #0081 Publisher の SessionMachine 駆動化
- #0073 sans-I/O SessionMachine の導入
- #0077 Session から SessionMachine への受信配線
