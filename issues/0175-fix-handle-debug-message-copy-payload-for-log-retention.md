# `handleDebugMessage` で `DebugMessage.payload` をコピーしてからログ保存する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`devtools/src/hooks/useSubscriber.ts:handleDebugMessage` と `devtools/src/hooks/usePublisher.ts:handleDebugMessage` は `message.payload` (Uint8Array) をそのまま `addLog` に渡し、`DebugPanel.tsx` の log buffer (現状 `logs` signal、0167 適用後は `logBuffer` プレーン配列) に最大 `MAX_LOGS` 件 (現状 1000 件) 保持される。

`moqt-js` 側 (`src/session.ts`) の `DebugMessage.payload` の寿命について JSDoc 上の契約が存在せず (`interface DebugMessage` の `payload` プロパティは `/** Raw payload bytes */` のみ)、devtools 側は寿命前提に依存して保持している状態である。

本 issue では「devtools 側で防御的にコピーする」と「moqt-js 側で寿命契約を JSDoc に明記する」の双方を行い、両端から寿命依存を明確化する。

## 関連 issue との順序

- 0167 (DebugPanel ログバッファ刷新): 0167 の `logBuffer.shift()` で先頭から削除された `LogEntry.payload` (Uint8Array) は他から参照されない限り GC される。本 issue でコピーした `Uint8Array` も `LogEntry` 内に保持されるだけで `shift` 後は GC 対象になる。本 issue と 0167 は先後どちらでも実装可能 (`addLog` のシグネチャは 0167 で変更されない)

## 根拠 (moqt-js 側の payload 寿命を実コードで確認した結果)

`src/session.ts` 内で `emitDebug` を呼び出している 5 箇所すべてで、`payload` は以下のいずれかであり、現状の moqt-js 実装では debug callback 復帰後も書き換え・detach されない:

1. **recv 側 (制御ストリーム経由)**: `handleControlMessage` で渡される `msg.payload` は `src/controlStream.ts:98` の `this.buffer.slice(typeConsumed + 2, totalLength)` 由来。`Uint8Array.prototype.slice` は新規 ArrayBuffer を確保した独立コピーを返す (TC39 ECMA-262 `%TypedArray%.prototype.slice`)。元 buffer は同 `ControlStreamReader` 内で `this.buffer.slice(totalLength)` により入れ替えられるが、これは新規 ArrayBuffer なので debug callback 側が保持する payload には影響しない
2. **send 側 (`sendControlMessage`)**: `emitDebug("send", type, payload, decoded)` に渡される `payload` は呼び出し元 (SETUP 送信、各種 PUBLISH/SUBSCRIBE/FETCH エンコード) で都度 `new Uint8Array(totalLength)` 等で組み立てた使い切りバッファ
3. **send 側 (`sendPublishDone`)**: `new Uint8Array(totalLength)` に都度組み立ててから `emitDebug` に渡している

つまり現状の moqt-js 実装では `DebugMessage.payload` を callback 復帰後も保持して安全。しかし `interface DebugMessage` の JSDoc にこの保証は書かれていないため、今後 moqt-js 側で「制御ストリームから受け取った Uint8Array を `subarray` で渡すように最適化」等の変更が入ると devtools 側が無症状に壊れる (現実的な未来シナリオは `controlStream.ts:98` の `slice` を `subarray` に変更してアロケーション削減する最適化)。

devtools 側の現状は寿命契約に依存しているため、防御的にコピーするのが妥当。

## 修正方針

### A. devtools 側 (防御的コピー)

両 hook の `handleDebugMessage` で以下のとおりコピーしてから `addLog` に渡す。

```ts
// moqt-js の DebugMessage.payload はライフタイム契約が JSDoc 上明文化されて
// いないため、ログ保持 (最大 MAX_LOGS 件) に備えて独立 Uint8Array へコピーする。
// new Uint8Array(typedArray) は新規 ArrayBuffer を確保した独立コピーを返す
// (TC39 ECMA-262 `%TypedArray%(typedArray)` 抽象操作)。
const payload = message.payload.length > 0 ? new Uint8Array(message.payload) : undefined;
addLog("info", logMessage, data, payload);
```

`message.payload.slice()` でも結果は等価だが、`new Uint8Array(typedArray)` のほうが「新規確保」の意図が明確に読めるため本 issue ではこれを採用する。`length === 0` のとき `undefined` を渡す挙動は現状維持 (`addLog` の `payload?: Uint8Array` 型契約上、空でも `undefined` でも下流処理は同じ)。

`usePublisher.ts:34` の既存コメント `// payload が存在する場合は渡す` は本 issue のコピー意図コメントに置換する。

両 hook の `handleDebugMessage` ロジックは完全一致 (15 行強で `subscriberId` 引数の差分のみ) で重複しているが、共通化は本 issue では行わない (本 issue の変更点を最小化するため)。共通化する場合は `devtools/src/utils/handleDebugMessage.ts` 等に純粋関数として切り出す方向で別 issue で扱う。

### B. moqt-js 側 (寿命契約の JSDoc 化)

`src/session.ts` の `interface DebugMessage` の `payload` プロパティ JSDoc を以下に置換する。文言は既存 JSDoc (英語) に合わせて英語で書く。

```ts
/**
 * Raw payload bytes.
 *
 * The Uint8Array is independent of moqt-js internal buffers and the receiver
 * MAY retain it beyond the callback. The receiver MUST NOT mutate it because
 * the same instance may be referenced by moqt-js internals after the callback
 * returns (e.g. for retransmission or further encoding).
 */
payload: Uint8Array;
```

### C. テスト戦略

`handleDebugMessage` を `useSubscriber.ts` / `usePublisher.ts` から **export** し、純粋関数化して単体テストする (`addLog` をテスト時のみ差し替える形は CLAUDE.md「モック禁止」に抵触するため、`addLog` ではなく 0167 の `getLogBuffer()` 経由で結果を観測する)。

`devtools/src/hooks/handleDebugMessage.test.ts` (もしくは既存 `useSubscriber.test.ts` / `usePublisher.test.ts`) に以下を追加:

- `handleDebugMessage(subscriberId, message)` 呼び出し後、`getLogBuffer()` の最後の entry の `payload.buffer !== message.payload.buffer` (独立 ArrayBuffer であること)
- 同じく最後の entry の `payload` が `message.payload` と同じバイト列であること
- `message.payload.length === 0` のとき、`payload` が `undefined` で記録されること

0167 で `getLogBuffer()` が export される前提を満たすため、本 issue は 0167 と独立に着手できるが、テスト追加は 0167 マージ後に行う方が自然。0167 が後着手なら、本 issue ではテストを書かず手動確認に委ねる選択肢も許容する (この場合は完了条件で明示する)。

### 手動確認

- `vp run test` で全テストパス
- `vp run build` / `vp run build:devtools` でビルド成功
- `vp run lint` / TypeScript 型チェック通過

## 影響範囲

- `devtools/src/hooks/useSubscriber.ts` の `handleDebugMessage` (export 追加 + payload コピー)
- `devtools/src/hooks/usePublisher.ts` の `handleDebugMessage` (同上)
- `src/session.ts` の `interface DebugMessage.payload` JSDoc 追記のみ (実装変更なし)
- `devtools/src/hooks/handleDebugMessage.test.ts` (新規、または既存テストファイルへの追加)
- CHANGES.md

## CHANGES.md 記載方針

devtools 側のコピー追加と JSDoc 追記の両方とも `### misc` サブセクションに `[UPDATE]` で記載する (CLAUDE.md で `[FIX]` は「バグ修正」、本 issue は将来の最適化に対する防御で実害発生前のため `[UPDATE]` が妥当。JSDoc 追記は公開 API ドキュメントの追加で挙動不変)。

エントリ例:

```
- [UPDATE] devtools の `handleDebugMessage` で `DebugMessage.payload` をコピーしてからログに保存する (#0175)
  - @voluntas
- [UPDATE] `DebugMessage.payload` の寿命契約 (independent / MAY retain / MUST NOT mutate) を JSDoc に明記する (#0175)
  - @voluntas
```

## ブランチ命名

`feature/fix-` を使う (公開 API 契約の明確化と devtools 側の防御で、種別としては fix 寄り)。

## 完了条件

- `useSubscriber.ts:handleDebugMessage` と `usePublisher.ts:handleDebugMessage` の双方で `new Uint8Array(message.payload)` 相当のコピーを経由してから `addLog` に渡る
- 両 `handleDebugMessage` が export されている
- `src/session.ts:interface DebugMessage` の `payload` JSDoc に寿命契約 (independent / MAY retain / MUST NOT mutate) が明記される
- 単体テスト (上記 3 件) が追加され、`vp run test` で全件パス (0167 未マージ時は手動確認に委ねる旨を本 issue 着手時に判断する)
- CHANGES.md `### misc` に `[UPDATE]` エントリ 2 件 (devtools コピー / JSDoc 追記) が追加されている
- `vp run build` / `vp run build:devtools` / `vp run lint` 成功
