# GOAWAY タイムアウトを SessionMachine の tick 駆動に移行する

Created: 2026-04-19
Model: Claude Opus 4.7

## 概要

現状 `Session` は GOAWAY の deadline を `setTimeout` で管理している。
`SessionMachine` には既に `tick(nowMs)` API と `_localGoawayDeadlineMs` 計算・
`closeSession(GOAWAY_TIMEOUT)` の発行が実装されており、二重管理になっている。

本 issue で Session 側の `setTimeout` を撤去し、`setInterval(tick)` に統一する。

## 背景

- #0073 の close 時に残した「GOAWAY タイムアウトを tick 駆動に寄せる」未対応分
- #0077 の残課題欄でも指摘済み

## RFC 根拠

`draft-ietf-moq-transport-17` Section 3.6 GOAWAY

- 受信側は timeout ms 以内にグレースフルシャットダウンする
- 期限超過時は GOAWAY_TIMEOUT でセッションを閉じる

## 設計判断

| 項目           | 決定                                                            |
| -------------- | --------------------------------------------------------------- |
| tick interval  | 250 ms (GOAWAY が秒単位なのでこの粒度で十分、CPU 負荷も低い)    |
| 起動タイミング | `established` 遷移時                                            |
| 停止タイミング | `close` / `closeWithError` 時にクリア                           |
| 時刻ソース     | `Date.now()` を引数に渡す (SessionMachine 側は sans-I/O を維持) |
| 廃止対象       | `Session.goawayTimeoutId` と `setTimeout`/`clearTimeout` 経路   |

## 作業内容

1. `Session` に `tickIntervalId` を追加し、`initialize()` の established 到達時に `setInterval(() => this.protocol.tick(Date.now()); this.drainMachineEvents(), 250)` を起動する
2. `close` / `closeWithError` で `clearInterval` する
3. `goaway()` と `handleGoaway` の `setTimeout` を削除し、SessionMachine の `localGoawayPendingTimeoutMs` / `_localGoawayDeadlineMs` 側に寄せる
4. drainMachineEvents で `closeSession(GOAWAY_TIMEOUT)` が来たら `closeWithError` する流れを確認する
5. `goawayTimeoutId` フィールドを削除する

## 影響範囲

- `src/session/session.ts` の GOAWAY 関連フロー
- 既存の GOAWAY 関連テストは sans-I/O 側でカバー済み

Completed: 2026-04-19

## 解決方法

- `Session` に `tickIntervalId` (setInterval 用) と `peerGoawayTimeoutId` (peer GOAWAY 受信時の setTimeout 用) を追加した
- `initialize()` の established 遷移後に 250ms 間隔で `protocol.tick(Date.now())` と `drainMachineEvents()` を実行する `setInterval` を起動する
- `close()` で `clearInterval(tickIntervalId)` と `clearTimeout(peerGoawayTimeoutId)` を呼ぶ
- 自側 `goaway()` で使っていた `setTimeout` を削除し、SessionMachine の `localGoawayDeadlineMs` による `closeSession(GOAWAY_TIMEOUT)` 発行に委ねた
- peer GOAWAY 受信時のグレースフルシャットダウン用 `setTimeout` は `peerGoawayTimeoutId` 変数にリネームして残した (SessionMachine では peer-received GOAWAY の deadline を計算していないため)
- `vp run typecheck` / `vp run test` (35 files / 441 tests) / `vp run build` (155.67 kB / gzip 31.69 kB) すべて緑
