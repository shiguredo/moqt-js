# 高レベル API (MediaPublisher / MediaSubscriber) に authorizationToken オプションを追加する

Created: 2026-04-29
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
- 既存テストファイル (新規テスト追加のみ)
