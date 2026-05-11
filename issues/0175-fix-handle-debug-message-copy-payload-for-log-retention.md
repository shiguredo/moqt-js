# `handleDebugMessage` で payload をコピーしてからログ保存する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`useSubscriber.ts:handleDebugMessage` は `addLog(..., message.payload)` のように `message.payload` (Uint8Array) をそのままログに渡している。DebugPanel はログを最大 MAX_LOGS 件保持するため、payload も同期間保持される。

`message.payload` の寿命契約が moqt-js 側で「コールバック復帰後は再利用される」「Worker への transfer で detach される」等の場合、ログ表示時に異なる中身が表示される / `ArrayBuffer detached` 例外になる可能性がある。

## 根拠

- `useSubscriber.ts:99-101`: `const payload = message.payload.length > 0 ? message.payload : undefined; addLog("info", logMessage, data, payload);`
- moqt-js 側の payload 寿命契約を確認するまでは想像の域だが、devtools のログ寿命は MAX_LOGS 件 (秒〜分単位) 残るためリスクが高い

## 修正方針

1. `handleDebugMessage` で `payload = new Uint8Array(message.payload)` のように複製してから `addLog` に渡す
2. moqt-js 側で payload の寿命契約を確認し、必要なら moqt-js 側 docstring に明記する
3. devtools 側のコメントで「ログ保持のため独立 Uint8Array にコピーする」と明示する

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts:handleDebugMessage`

## テスト戦略

- `vp run test` で全テストがパスすること
- 単体テストで「payload を後から書き換えてもログの内容が保持されること」を検証

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で記載する

## 完了条件

- `handleDebugMessage` で payload がコピー保存される
- 全テストパス
