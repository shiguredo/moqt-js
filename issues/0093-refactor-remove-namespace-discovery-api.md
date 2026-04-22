# Namespace announce/discovery API を削除

Created: 2026-04-22
Model: Claude Opus 4.7

## 概要

namespace ベースの announce / discovery API
(`Session.publishNamespace` / `Session.subscribeNamespace`、関連型 `NamespaceAnnouncement`
/ `NamespaceSubscription` / `NamespaceSubscriptionCallbacks`) を削除する。
SessionMachine 側の namespace 状態管理、関連 encoder / decoder、テストも併せて削除する。

## 背景

AGENTS.md の moqt-js 方針:

> - クライアントとしてのみ動作
> - MOQT Publisher/Subscriber としてのみ動作

draft-ietf-moq-transport-17 の namespace API は以下の用途を持つ:

- `PUBLISH_NAMESPACE` (§9.17): publisher が namespace を announce し、subscriber が SUBSCRIBE を送ってくるのを待つ (pull 型 publisher)
- `SUBSCRIBE_NAMESPACE` (§9.20): subscriber が namespace を購読し、relay が forward する PUBLISH を受ける (push 型 subscriber / discovery)

これらは **peer から開始される request の受信が成立して初めて意味を持つ**:

- `publishNamespace` で announce しても、戻ってくる SUBSCRIBE を受けられないと publisher として何もできない
- `subscribeNamespace` で discover しても、降ってくる PUBLISH を受けられないと subscriber として何もできない

issue 0092 で peer-initiated request 受信機構を削除すると、namespace API は応答相手が居なくなり機能不全となる。
高レベル API (`createMediaPublisher` / `createMediaSubscriber`) も devtools も namespace API を使っていない。
moqt-js のスコープ (push publish + pull subscribe) では out-of-band で namespace を共有する想定とし、本 API は削除する。

## 設計判断

- namespace の出口送信と入り応答受信は両方とも削除する
- `PUBLISH_NAMESPACE` / `SUBSCRIBE_NAMESPACE` / `PUBLISH_NAMESPACE_DONE` / `NAMESPACE_DONE` 等の関連メッセージを controlStream で受信した場合は PROTOCOL_VIOLATION で切断する
- 0092 で peer-request 受信が消えていれば自然に PROTOCOL_VIOLATION 経路に落ちる

## 作業内容

### 公開 API 削除

1. `src/session/session.ts`:
   - `publishNamespace()` / `subscribeNamespace()` メソッド削除
   - 関連型 `NamespaceAnnouncement` / `NamespaceSubscription` / `NamespaceSubscriptionCallbacks` 削除
   - 内部状態 (publishedNamespaces / subscribedNamespaces 等) 削除

2. `src/index.ts`:
   - `NamespaceAnnouncement` / `NamespaceSubscriptionCallbacks` / `NamespaceSubscription` の re-export 削除

### SessionMachine 側削除

3. `src/session/machine.ts`:
   - namespace 関連 outgoing request の状態管理削除
   - `handle*Namespace*` 系の入力ハンドラ削除 (0092 完了時点で大半は消えている想定)

### message 層削除

4. `src/message/session.ts` または該当ファイル:
   - `PUBLISH_NAMESPACE` / `SUBSCRIBE_NAMESPACE` / `PUBLISH_NAMESPACE_DONE` 等の encoder / decoder 削除
   - MessageType enum から該当値削除はせず、controlStream 受信時に PROTOCOL_VIOLATION とする扱いに整理
     (受信時は「未対応の制御メッセージ」として SessionMachine が既に PROTOCOL_VIOLATION で切断する)

### テスト削除

5. `src/session/namespace.ts` / `src/session/namespace.prop.ts` を削除
6. `src/session/session.test.ts` 等から namespace 関連ケース削除

## 検証

- `vp run typecheck` / `vp run test` / `vp run build` を全て通すこと
- `createMediaPublisher` / `createMediaSubscriber` の挙動が変わらないこと
- devtools のビルドが通ること

## 規模

削除行数の目安: 数百行

## 依存

- 0092 完了後に実施する
- 順序を逆にすると 0092 で peer-request を消した瞬間に namespace API が半壊するため
