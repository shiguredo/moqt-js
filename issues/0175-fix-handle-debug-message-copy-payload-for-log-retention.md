# `handleDebugMessage` で `DebugMessage.payload` をコピーしてからログ保存する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts:handleDebugMessage` と `devtools/src/hooks/usePublisher.ts:handleDebugMessage` は `message.payload` (Uint8Array) をそのまま `addLog` に渡し、`DebugPanel.tsx` の `logs` signal に最大 `MAX_LOGS` 件 (現状 1000 件) 保持される。

`moqt-js` 側 (`src/session.ts`) の `DebugMessage.payload` の寿命について JSDoc 上の契約が存在せず (`src/session.ts:94-107` の `interface DebugMessage` に「callback 復帰後は再利用される」「再利用されない」のいずれも書かれていない)、devtools 側は寿命前提に依存して保持している状態である。

本 issue では「devtools 側で防御的にコピーする」と「moqt-js 側で寿命契約を JSDoc に明記する」の双方を行い、両端から寿命依存を明確化する。

## 根拠 (moqt-js 側の payload 寿命を実コードで確認した結果)

`src/session.ts` 内で `emitDebug` を呼び出している 5 箇所すべてで、`payload` は以下のいずれかであり、現状の moqt-js 実装では **debug callback 復帰後も書き換え・detach されない**:

1. **recv 側 (制御ストリーム経由)** — `src/session.ts:1021` (SETUP recv) と `:2701` (handleControlMessage) で渡される `msg.payload` / `payload` は `src/controlStream.ts:98` の `this.buffer.slice(typeConsumed + 2, totalLength)` 由来。`Uint8Array.prototype.slice` は **新規 ArrayBuffer を確保した独立コピー** を返す (cf. ECMA-262 23.2.3.24)。元 buffer は同 `ControlStreamReader` 内で `this.buffer.slice(totalLength)` により入れ替えられるが、これは新規 ArrayBuffer なので debug callback 側が保持する payload には影響しない
2. **send 側 (sendControlMessage)** — `src/session.ts:2185` で `this.emitDebug("send", type, payload, decoded)` に渡される `payload` は呼び出し元 (例: `:932` SETUP 送信、各種 PUBLISH/SUBSCRIBE/FETCH エンコード) で都度 `new Uint8Array(totalLength)` 等で組み立てた使い切りバッファ。送信後にも変更・transfer されない
3. **send 側 (sendPublishDone)** — `src/session.ts:2465-2478` で `new Uint8Array(totalLength)` に都度組み立ててから `emitDebug` に渡している

つまり **現状の moqt-js 実装では `DebugMessage.payload` を callback 復帰後も保持して安全**。しかし `interface DebugMessage` の JSDoc にこの保証は書かれていない (`src/session.ts:101-102` は単に `/** Raw payload bytes */ payload: Uint8Array;`)。今後 moqt-js 側で「制御ストリームから受け取った Uint8Array を `subarray` で渡すように最適化」「Worker transfer で再利用」等の変更が入ると devtools 側が無症状に壊れる。

devtools 側の現状 (`useSubscriber.ts:99-100` / `usePublisher.ts:35-36`) は寿命契約に依存しているため、防御的にコピーするのが妥当。

## 修正方針

### A. devtools 側 (防御的コピー)

両 hook の `handleDebugMessage` で以下のとおりコピーしてから `addLog` に渡す。

```ts
// moqt-js の DebugMessage.payload はライフタイム契約が JSDoc 上明文化されて
// いないため、ログ保持 (最大 MAX_LOGS 件) に備えて独立 Uint8Array へコピーする。
const payload =
  message.payload.length > 0 ? new Uint8Array(message.payload) : undefined;
addLog("info", logMessage, data, payload);
```

`new Uint8Array(typedArray)` は元の view の length 分の新規 ArrayBuffer を確保した独立コピーになる (ECMA-262 23.2.1.2)。`message.payload.slice()` でも等価。

### B. moqt-js 側 (寿命契約の JSDoc 化)

`src/session.ts:94-107` の `interface DebugMessage` の `payload` プロパティ JSDoc に以下を追記する。

```ts
/**
 * Raw payload bytes.
 *
 * The Uint8Array is independent (its ArrayBuffer is not reused by moqt-js
 * internals) and the receiver MAY retain it beyond the callback. However, the
 * receiver MUST NOT mutate it, as the same instance may also be observed by
 * other callbacks.
 */
payload: Uint8Array;
```

文言は英語で記述する (CLAUDE.md「ログメッセージは全て英語」「コメントは全て日本語」のうち API ドキュメントとして公開される JSDoc は英語が妥当 — 既存の `DebugMessage` JSDoc も英語)。

### C. (任意) 共通化検討

`useSubscriber.ts` と `usePublisher.ts` で同一の payload 加工ロジックが重複している。本 issue では共通化は行わない (Premature Optimization)。将来 `useCopyFeedback` 抽出と同様の hook 化が必要になったら別 issue で扱う。

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` — `handleDebugMessage` の payload 受け渡し
- `devtools/src/hooks/usePublisher.ts` — `handleDebugMessage` の payload 受け渡し
- `src/session.ts` — `interface DebugMessage.payload` の JSDoc 追記のみ (実装変更なし)

## テスト戦略

- `vp run test` で全テストがパスすること
- `vp run build` および `vp run build:devtools` でビルドが通ること
- 手動確認は不要 (寿命契約に依存する不具合は現状の moqt-js 実装では再現しないため。本修正は将来の moqt-js 内部最適化に対する防御)

## CHANGES.md 記載方針

- `### misc` サブセクションに `[FIX]` で「`DebugMessage.payload` を devtools 側でコピーしてからログに保存するように修正する」を記載する
- `## develop` の通常セクションに `[UPDATE]` で「`DebugMessage.payload` の寿命契約を JSDoc に明記する」を記載する (公開 API ドキュメントの追記)

## 完了条件

- `useSubscriber.ts:handleDebugMessage` と `usePublisher.ts:handleDebugMessage` の双方で `new Uint8Array(message.payload)` 相当のコピーを経由してから `addLog` に渡る
- `src/session.ts:DebugMessage.payload` の JSDoc に寿命契約 (independent / MAY retain / MUST NOT mutate) が明記される
- 全テストパス
