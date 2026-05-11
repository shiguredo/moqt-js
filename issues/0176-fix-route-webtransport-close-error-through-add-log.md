# WebTransport `close` / `error` コールバックを `addLog` 経由で観測可能にする

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts` の `connect` 内 `close` / `error` コールバックは `console.log` / `console.error` でしか出力されず、DebugPanel のログ系経路には流れない。一方 `handleDebugMessage` は `addLog("info", ...)` を使う。経路によって DebugPanel での可視性が変わるため、devtools の役割上 (=「内部失敗を可視化する」) 一本化すべき。

## 根拠

- `useSubscriber.ts:close` コールバック: `console.log(...)` + `statusMessage` 直接更新のみ
- `useSubscriber.ts:error` コールバック: `console.error(...)` + `statusMessage` 直接更新のみ
- `handleDebugMessage` は `addLog` 経由
- DebugPanel は MOQT 内部の挙動をユーザーに見せるツールなので close / error も DebugPanel ログとして出るべき

## 修正方針

1. `close` コールバック内で `addLog("warn", "[<subscriberId>] WebTransport closed", { closeCode, reason })` を呼ぶ
2. `error` コールバック内で `addLog("error", "[<subscriberId>] WebTransport error", { message: error.message })` を呼ぶ
3. 同様に `Catalog stream ended` / `Catalog subscribe error` / `Catalog received` の各箇所も addLog 経由に統一する (既に一部は addLog 経由)
4. `renderFrame` の `console.warn` も DebugPanel 経由に移送するか別 issue に分離する

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts`

## テスト戦略

- `vp run test` で全テストがパスすること
- 手動: サーバ切断時に DebugPanel に "WebTransport closed" が出ることを確認

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する

## 完了条件

- close / error コールバックが `addLog` 経由で DebugPanel に流れる
- 全テストパス
