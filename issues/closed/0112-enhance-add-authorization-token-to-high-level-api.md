# 高レベル API (MediaPublisher / MediaSubscriber) に authorizationToken オプションを追加する

Created: 2026-04-29
Completed: 2026-04-29
Model: Opus 4.7

## 概要

`Session` (低レベル) の `ConnectOptions` には issue 0098 で `authorizationToken` を追加済みだが、高レベル API である `createMediaPublisher` / `createMediaSubscriber` には未露出。認証付き Relay (例: Sora MOQT) に高レベル API のまま接続する手段が無い。

`MediaPublisherOptions` / `MediaSubscriberOptions` に `authorizationToken` を追加し、内部の `connect()` 呼び出しに伝搬する。

## 根拠

- draft-ietf-moq-transport-17 §9.4.1.4 (AUTHORIZATION TOKEN Setup Option)
- 低レベル API では既に対応済み (issue 0098)
- moqt-devtools の入力欄も既に対応済み (issue 0099)
- E2E テスト (Playwright) で認証付きサーバへ接続する前提条件として必要

## スコープ

- `MediaPublisherOptions` / `MediaSubscriberOptions` への `authorizationToken` 追加のみ
- 値は `Session.ConnectOptions.authorizationToken` にそのまま渡す
- 公開済みの `AuthorizationToken` 型 (`src/index.ts`) を再利用するため、新規型定義は作らない

## 変更内容

### 型

- `src/codec/types.ts`
  - `MediaPublisherOptions` に `authorizationToken?: AuthorizationToken` を追加
  - `MediaSubscriberOptions` に `authorizationToken?: AuthorizationToken` を追加
  - `AuthorizationToken` は `../session` から import する

### 配線

- `src/createMediaPublisher.ts`
  - `connectToServer()` 内で `connectOptions.authorizationToken` に `this.options.authorizationToken` を伝搬する
- `src/createMediaSubscriber.ts`
  - 同上

### テスト

- `src/createMediaPublisher.test.ts` / `src/createMediaSubscriber.test.ts` に `authorizationToken` を渡してオプションが受理されることを確認するテストを追加する
- 既存テストパターン (Vitest の Chai API、モック禁止) を踏襲する

## 影響範囲

- `src/codec/types.ts`
- `src/createMediaPublisher.ts`
- `src/createMediaSubscriber.ts`

## 解決方法

- `src/codec/types.ts` の `MediaPublisherOptions` / `MediaSubscriberOptions` に `authorizationToken?: AuthorizationToken` を追加した。型は inline import (`import("../message").AuthorizationToken`) で `Catalog` (`import("../msf").Catalog`) と同じ流儀に揃えた。session.ts は AuthorizationToken を message から import しているだけで再エクスポートしていないため、message から直接 inline import している。
- `src/createMediaPublisher.ts` / `src/createMediaSubscriber.ts` の `connectToServer()` で、ローカルに作っていた `connectOptions` の型を `ConnectOptions` (session から import) に揃えた。`this.options.authorizationToken` が存在する場合のみ `connectOptions.authorizationToken` に代入して `connect()` に渡す。`CertificateHash` の直接 import は不要になったため削除した。
- 高レベル API は元から単体テストファイルが存在せず (WebTransport モック禁止のため)、低レベル `Session` 側は issue 0098 でテスト済み。今回はパススルーの伝搬のみのため新規単体テストは追加せず、E2E (Playwright) で実動作を実証する方針 (issue 0113 で対応予定)。
- `vp run typecheck` / `vp lint` / `vp test` (394 tests) / `vp run build` がすべて通ることを確認した。
- `CHANGES.md` の `## develop` に `[ADD]` エントリを追加した。
