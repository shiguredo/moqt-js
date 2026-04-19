# Publisher を SessionMachine 駆動に置き換える

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

`src/publisher.ts` の `Publisher` は現在、自前で `publisherState` / `publisherForwardState` を保持し、`session.ts` からの setter 呼び出し (`setForwardState` など) によって状態が更新される構造になっている。
`Session` (`src/session/session.ts`) は SessionMachine からイベントを受け取ったあと、ほぼ 1 対 1 で Publisher のメソッドを呼ぶ「ルーティング層」を手書きしており、グルーコードが積み上がっている。

`SessionMachine` 側は既に subscription / publication の並行状態を内部で完全に持っているため、Publisher はその状態を射影するだけの facade で足りる。本 issue で Publisher を SessionMachine 駆動の facade に書き換え、`session.ts` のグルーコードを削減する。

## 背景

- #0073 で sans-I/O な `SessionMachine` を導入し、subscription / publication / fetch / namespace の並行状態を SessionMachine 内部の `_subscriptions` / `_peerPublisherAliases` などに集約済み
- #0077 で `Session` 受信経路を SessionMachine に流し込む構造になったが、`Session` が SessionMachine のイベントを受けて Publisher の setter を呼ぶコード (ルーティング) が残っている
- Publisher は state を独自に保持していて、SessionMachine の state と二重管理になっている

## 方針

1. **Publisher の state を SessionMachine 由来の射影にする**
   - `Publisher.state` は SessionMachine の該当 subscription エントリから都度 derive する
   - `publisherForwardState` / `publisherState` の local フィールドを撤去する
2. **Publisher が SessionMachine のイベントを subscribe する**
   - `Session` が手書きしている `handlePublishOk` / `handleRequestUpdate` / `handlePublishDone` 相当のルーティングを Publisher 側で受け取る (SessionMachine の `SessionEvent` を絞り込んで直接購読する形)
   - `session.ts` から Publisher 関連の setter / cleanup 呼び出しを削除する
3. **SessionMachine 側の公開 API 拡充**
   - 特定 requestId に対する view (`getPublication(requestId)` や event subscription) を必要に応じて追加する
   - 足りなければ本 issue 内で SessionMachine 側にも API を足す
4. **I/O は引き続き Session が担当**
   - Publisher の `sendObject` / `sendDatagram` など WebTransport への実 I/O は Session の callback (`onSendObject` など) 経由のまま
   - Publisher はあくまで「状態の facade + I/O callback の shim」になる

## 影響範囲

- `src/publisher.ts` (約 210 行) の大幅書き換え
- `src/session/session.ts` の Publisher 関連ルーティング削除
- `src/session/machine.ts` に Publisher 向けの view API 追加
- `src/publisher.test.ts` / `src/publisher.prop.ts` (新設) の更新
- `CHANGES.md` に `[CHANGE]` として記載 (公開 API に破壊的変更あり)

## リスク

| ID  | リスク                                                                      | 緩和                                                                                       |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | Publisher の状態取得がホットパス (`sendObject` 毎) で SessionMachine を叩く | 射影は `getPublication(requestId)` の O(1) Map lookup に留め、イベント購読はキャッシュする |
| R2  | 既存テストが `Publisher.setForwardState()` を直接呼ぶため書き換えが必要     | SessionMachine を feed → Publisher view を assert する形に test を先に書き換える           |
| R3  | SessionMachine 側の API 追加で責務が肥大化する                              | 追加する API は view (read-only) に限定し、状態変更系は追加しない                          |

## 段階的な進め方

1. Phase 1: SessionMachine 側に Publisher 向けの view API (`getPublicationView(requestId)`) を追加し、PBT を書く
2. Phase 2: Publisher を view 参照型に書き換え、local state を撤去する。テストを先に書き換える
3. Phase 3: `session.ts` の Publisher 関連ルーティングを削除し、event 購読に置き換える
4. Phase 4: CHANGES.md 更新、typecheck / test / build 緑を確認する

各 Phase を 1 コミットとする。

## 参考

- #0073 sans-I/O SessionMachine の導入
- #0077 Session から SessionMachine への受信配線
- #0080 peer-initiated request の受信経路
