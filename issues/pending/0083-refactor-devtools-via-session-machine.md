# devtools を SessionMachine のイベント駆動に置き換える

Created: 2026-04-19
Model: Claude Opus 4.7

## pending 理由

2026-04-19 時点で pending 送りとする。

事前調査の結果、devtools の polling ループの大半は WebCodecs の `encoder.state` / `decoder.state` が対象であり、これは MOQT / SessionMachine の守備範囲外である。MOQT 由来で polling している箇所は `publisher.state === "active"` / `subscriber.state === "active"` の送信前ガード程度で、これは既存の `onForwardStateChange` / `onEnd` / `close` / `goaway` コールバックで概ね代替可能な水準である。

一方で本 issue は moqt-js 本体に `Session.onStateChange` や `Session.events` といった新規 observable API を追加する想定であり、追加コストに対して devtools 側の実際の削減量が見合わない。devtools のリグレッション検知も現状 Playwright e2e のみで網が粗い。

そのため、以下のいずれかのトリガが発生するまでは本 issue を保留する。

- devtools を「MOQT プロトコル観測ツール」として強化する要件が明確になったとき (SessionMachine の state transition や peer-initiated request を可視化したい、など)
- moqt-js の他の利用者から observable API の要望が上がったとき
- devtools 側で polling 起因の不具合・パフォーマンス問題が具体化したとき

## 概要

`devtools/` は現在 Session 内部の低レイヤー API を直接触って状態を観測している。具体的には `pub.publisher.value.state !== "active"` や `instance.subscriber.state === "active"` のような polling ループと、`decoderConfigured` / `joiningFetchInProgress` / `sentGoaway` 的な ad-hoc フラグでライフサイクルを手管理している。

#0081 (Publisher) / #0082 (Subscriber) で Publisher / Subscriber が SessionMachine 駆動の facade になった前提で、devtools も SessionMachine が発行する event / state を直接参照する event-driven な構造に置き換え、独自の状態管理コードを削減する。

## 背景

- #0073 で sans-I/O な `SessionMachine` が導入され、session / subscription / publication / fetch / namespace の状態遷移が一元管理されるようになった
- devtools は moqt-js の公開 API クライアントだが、内部 state を覗く polling 前提で書かれている
- #0081 / #0082 で Publisher / Subscriber が SessionMachine view の facade になるため、devtools が観測したい情報 (state, protocol event, GOAWAY timer など) は SessionMachine から直接取得できる状態になる

## 方針

1. **Session に observable な event / state API を公開する**
   - `Session.onStateChange(listener)` / `Session.events` (SessionMachine の `SessionEvent` を転送する購読 API) を新設する
   - SessionMachine 内部をそのまま外に出すのではなく、devtools 用途に必要な subset を Session の公開 API として整備する
   - API 草案は本 issue のコメントで合意してから実装する
2. **devtools の polling を event 購読に置き換える**
   - `usePublisher.ts` / `useSubscriber.ts` の `while` ループと signals の ad-hoc フラグ (`decoderConfigured`, `joiningFetchInProgress`, `sentGoaway`, `receivedGoaway`) を SessionMachine event から derive する
   - `signals/publisher.ts` / `signals/subscriber.ts` は SessionMachine event をそのまま signal に写像する thin layer にする
3. **protocol 観測ログの拡充**
   - 現状 `handleDebugMessage()` は SEND / RECV 単位のログのみ
   - SessionMachine の state transition や peer-initiated request 受信を DebugPanel に出せるようにする (観測ツールとしての価値を上げる副次目標)
4. **WebCodecs 側は対象外**
   - `encoder.state === "configured"` / `decoder.state === "configured"` の polling は WebCodecs 固有の話で SessionMachine は関知しない。本 issue では触らない

## 影響範囲

- `src/session/session.ts` に observable API を追加
- `src/session/machine.ts` に devtools が観測したいイベント種別が不足していれば追加する
- `devtools/src/signals/` / `devtools/src/hooks/` の書き換え
- `devtools/src/components/DebugPanel.tsx` に SessionMachine state transition ログを追加
- `playwright.config.ts` 配下の e2e テストが polling 前提の実装を叩いていないか確認
- `CHANGES.md` に `[ADD]` (Session の observable API 追加) と `[CHANGE]` (devtools 内部書き換えに破壊的変更があれば) を記載

## リスク

| ID  | リスク                                                                               | 緩和                                                                                             |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| R1  | Session の observable API 設計が粗いと SessionMachine 内部実装が外に漏れる           | API 草案を issue で合意してから実装、公開するのは subset に限定する                              |
| R2  | devtools が e2e テスト (Playwright) しか持たないため event-driven 化でリグレッション | Playwright シナリオで publisher / subscriber 接続 → GOAWAY の画面遷移を緑に保つ                  |
| R3  | SessionMachine 側に足りないイベント (例: forwardState 変化) が発覚して設計変更       | 足りなければ本 issue 内で SessionMachine に event を追加する (CLAUDE.md: 後方互換性は考慮しない) |

## 段階的な進め方

1. Phase 1: Session に observable API (`onStateChange` / `events`) の草案を書き、本 issue 上で合意する
2. Phase 2: Session に observable API を実装する。SessionMachine 側にイベントが足りなければ追加する。テスト追加
3. Phase 3: devtools の Publisher 系 signal / hook を event 購読に置き換える
4. Phase 4: devtools の Subscriber 系 signal / hook を event 購読に置き換える
5. Phase 5: DebugPanel に SessionMachine state transition ログを追加
6. Phase 6: CHANGES.md 更新、Playwright 緑を確認する

各 Phase を 1 コミットとする。

## 前提

- #0081 (Publisher の SessionMachine 駆動化) が完了していること
- #0082 (Subscriber の SessionMachine 駆動化) が完了していること
- #0081 / #0082 で確立する view API パターンを Session の observable API 設計にフィードバックする

## 参考

- #0081 Publisher の SessionMachine 駆動化
- #0082 Subscriber の SessionMachine 駆動化
- #0073 sans-I/O SessionMachine の導入
