# DebugPanel のログ蓄積 O(N) コピーと autoScroll 再発火を解消する

Created: 2026-05-11
Completed: 2026-05-12
Model: Opus 4.7

## 概要

`devtools/src/components/DebugPanel.tsx` のログ蓄積に二つの構造的問題がある。

1. `addLog` (183 行目) が `logs.value = [...logs.value, entry].slice(-MAX_LOGS);` で実装されており、ログ追加 1 回ごとに最大 `MAX_LOGS = 1000` 要素のスプレッドと `slice` で実体コピーが 2 回走る。さらに `logs` の signal 参照が差し替わるため `logs.value` を購読している全箇所が再評価対象になる。
2. オートスクロール用 `useSignalEffect` (508-513 行目) が `logs.value.length`・`autoScroll.value`・`logContainerRef.current` を全て購読しており、`autoScroll` トグル操作だけでも effect が再発火する。`autoScroll` を OFF→ON へ切り替えると、ログ追加が一切無くても `scrollTop = 0` が即座に実行され、ユーザーが直前まで手動スクロールしていた位置が破壊される。

本 issue では (1)(2) を同時に解消する。**パネル閉時のログ蓄積停止 (機能変更) は本 issue では扱わない**。必要であれば別 issue を切る。

## 根拠

### 性能 (1) の根拠

- `addLog` の `[...logs.value, entry].slice(-MAX_LOGS)` はスプレッドで 1 回、`slice` で 1 回、計 2 回の実体コピー。`MAX_LOGS = 1000` 到達後は常に 1000 要素ぶんのコピーを 2 回行う
- `logs` は `Signal<LogEntry[]>` のため、`logs.value = newArray` で参照が差し替わると以下の購読が全て再評価される
  - `devtools/src/App.tsx:103,105` (`logs.value.length` バッジ)
  - `DebugPanel.tsx:349-350` (`generateLogsText` フィルタ)
  - `DebugPanel.tsx:444` (`toggleExpandAll` 内 `logs.value.map(...).filter(...)`)
  - `DebugPanel.tsx:509` (`useSignalEffect` 内 `logs.value.length`)
  - `DebugPanel.tsx:527` (`clearLogs`)
  - `DebugPanel.tsx:544` (`firstTimestamp` 算出)
  - `DebugPanel.tsx:601` (`Logs: {logs.value.length}` 表示)
  - `DebugPanel.tsx:671,679-680` (描画ループ)
- MOQT の典型ワークロード (Publisher が 30 fps で OBJECT 送出 + Subscriber 複数 + Catalog / Control メッセージ) ではログ追加レートが数十〜数百件/秒に達する。`addLog` が毎回 1000 要素のフルコピー × 2 を行うのは無駄
- 「実測で UI がカクついている」という確証は現時点で取れていないため、CLAUDE.md の Premature Optimization 警告との兼ね合いで本 issue の優先度は中。**実装時には性能計測 (下記テスト戦略 2.) を残し、回帰検出に使えるようにする**

### autoScroll (2) の根拠

- 現コード (508-513 行目):

  ```tsx
  useSignalEffect(() => {
    const logsLength = logs.value.length;
    if (logsLength > 0 && autoScroll.value && logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  });
  ```

- `autoScroll.value` を effect 内で素直に読んでいるため、`autoScroll` 変化のたびに effect が再発火する。本来意図しているのは「`autoScroll` が ON の状態で新規ログが追加されたとき先頭へスクロールする」で、`autoScroll` トグルそのものでは発火させたくない
- `@preact/signals` の `signal.peek()` を使えば依存追跡せずに値だけ読めるため、`logs` 側の変化のみで発火するようになる

## 採用方針

**「追加シーケンス signal + 件数 signal + プレーン配列」の 3 点分離** を採る。

- `logBuffer`: プレーン配列 (signal ではない)。`push` / `shift` で破壊的に操作する
- `logSequence`: ログ追加の累積回数を表す signal。`addLog` のたびに増加し、MAX_LOGS 到達後も増え続ける。**autoScroll effect の発火源** および**描画再評価のトリガ**として使う
- `logCount`: `min(logSequence, MAX_LOGS)` 相当の現件数 signal。`Logs: N` 表示・バッジ・空判定で使う

**`logSequence` を分離する理由 (重要)**: `logCount` (件数) だけでは MAX_LOGS 到達後に値が `MAX_LOGS` のまま変化しなくなり、signal の同値判定でオートスクロール effect が発火しなくなる。追加イベントを取りこぼさないために累積カウンタを別に持つ必要がある。

**不採用**:

- リングバッファ (固定長配列 + write index): 描画時の順序復元コストが入り、`MAX_LOGS = 1000` 程度では複雑度に見合わない
- `useRef` のみで管理: `App.tsx` から件数を参照できなくなる
- `Signal<readonly LogEntry[]>` のラップ維持: 参照差し替えコストが残り目的を達成しない

## 修正方針

### `DebugPanel.tsx` の変更

1. import を更新する:

   ```ts
   import { signal, useSignalEffect, batch } from "@preact/signals";
   ```

   `peek()` は `Signal` インスタンスのメソッドなので追加 import 不要。`batch` は `addLog` / `clearLogs` 内で `logCount` と `logSequence` を同時更新する際に effect の二重発火を防ぐ目的で使う。

2. モジュールスコープの状態を再構成する:

   ```ts
   // 配列本体は破壊的に操作するため signal にしない
   const logBuffer: LogEntry[] = [];
   // 追加イベントの累積カウンタ。MAX_LOGS 到達後も増え続け、
   // autoScroll effect / 描画再評価のトリガになる
   export const logSequence = signal(0);
   // 現在の件数表示用 signal。logSequence と一緒に更新する
   export const logCount = signal(0);
   export const autoScroll = signal(true);
   ```

   既存の `export const logs = signal<LogEntry[]>([])` は削除する。

3. `addLog` を書き換える:

   ```ts
   export function addLog(
     level: LogEntry["level"],
     message: string,
     data?: unknown,
     payload?: Uint8Array,
   ): void {
     const entry: LogEntry = { timestamp: Date.now(), level, message, data, payload };
     logBuffer.push(entry);
     if (logBuffer.length > MAX_LOGS) {
       // MAX_LOGS = 1000 程度では shift 1 回のコストで十分。
       // スプレッド + slice の 2 回コピーから 1 回コピーに削減する。
       logBuffer.shift();
     }
     // 2 つの signal を同時更新するため batch で effect の二重発火を防ぐ
     batch(() => {
       // 件数は MAX_LOGS で頭打ち
       logCount.value = logBuffer.length;
       // シーケンスはモノトニックに増加 (effect の発火源)
       logSequence.value = logSequence.value + 1;
     });
   }
   ```

4. `clearLogs` を書き換える:

   ```ts
   const clearLogs = () => {
     logBuffer.length = 0;
     batch(() => {
       logCount.value = 0;
       // clear イベントを effect 側へ伝播させるため bump する
       logSequence.value = logSequence.value + 1;
     });
   };
   ```

5. `useSignalEffect` (508-513 行目) を以下に書き換える:

   ```ts
   useSignalEffect(() => {
     // logSequence の変化でのみ発火し、autoScroll トグル単体では発火しない
     const sequence = logSequence.value;
     if (sequence === 0) return;
     if (!autoScroll.peek()) return;
     if (logBuffer.length === 0) return;
     if (logContainerRef.current) {
       logContainerRef.current.scrollTop = 0;
     }
   });
   ```

6. 配列本体を参照する箇所はすべて `logBuffer` を直接読むよう書き換える:
   - `generateLogsText` (347-368 行目) の `logs.value` → `logBuffer`
   - `toggleExpandAll` (440-447 行目) の `logs.value` → `logBuffer`
   - `firstTimestamp` (544 行目) の `logs.value` → `logBuffer`
   - 描画ループ (671, 679-680 行目) の `logs.value` → `logBuffer`
   - 件数表示 (601 行目): `Logs: {logs.value.length}` → `Logs: {logCount.value}`
   - 空判定 (671 行目): `logs.value.length === 0` → `logCount.value === 0`

7. **`logCount` は MAX_LOGS で頭打ちになるため、それ単独では MAX_LOGS 到達後の再レンダリングがトリガされない**。`logSequence` を `DebugPanel` 関数本体の冒頭で `void logSequence.value;` の形で読むダミー参照を入れ、追加イベントごとの再レンダリングを保証する。これによって `firstTimestamp` (shift で先頭が変わる) も追加イベントごとに再計算される。

   ```tsx
   export function DebugPanel({ ... }: DebugPanelProps) {
     // ログ追加イベント (MAX_LOGS 到達後も含む) で再レンダリングをトリガするため、
     // logSequence を購読する。値自体は使わない。
     void logSequence.value;
     // ...
   }
   ```

   モジュールスコープ関数 (`generateLogsText` 等) は `DebugPanel` の render context から呼ばれるため、render 内で `logBuffer` のスナップショットを読めば最新状態が得られる。

### `App.tsx` の変更

- `import { DebugPanel, logs } from "./components/DebugPanel";` を `import { DebugPanel, logCount } from "./components/DebugPanel";` に変更
- `logs.value.length` (103, 105 行目) を `logCount.value` に置き換え

## 影響範囲

- `devtools/src/components/DebugPanel.tsx` (本体)
- `devtools/src/App.tsx` (export 名の変更に追従)
- `devtools/src/components/DebugPanel.test.ts` (新規)

`logs` を import している箇所は `App.tsx` のみ (grep 確認済み)。`addLog` を import している箇所 (`hooks/usePublisher.ts:15`, `hooks/useSubscriber.ts:12`) は API 互換なので変更不要。

## 関連 issue

- `issues/closed/0140-design-replace-max-logs-signal-with-constant.md` (`maxLogs` signal → 定数)
- `issues/closed/0142-design-avoid-reverse-copy-in-debug-panel-render.md` (描画時の reverse copy 廃止)
- `issues/0166-perf-live-object-buffer-use-ref.md` (同種の「配列 signal → プレーン配列 + count signal」パターン。実装の手本)
- `issues/0175-fix-handle-debug-message-copy-payload-for-log-retention.md` (本 issue とは独立だが、ログ長期保持に伴う payload 寿命問題)

## テスト戦略

`vp run test` で `tests/`・`src/`・`devtools/src/` の全テストが通ること。加えて以下を新規追加する。Vitest の `test` / `assert` を利用し、モック・スタブは使用しない。

### 単体テスト (`devtools/src/components/DebugPanel.test.ts`)

1. `addLog` を `MAX_LOGS + 1` 回呼んだ後、`getLogBuffer().length === MAX_LOGS` かつ `logCount.value === MAX_LOGS` かつ `logSequence.value === MAX_LOGS + 1` であること
2. `addLog` を `MAX_LOGS * 2` 回呼んだ後でも `logCount.value === MAX_LOGS` かつ `logSequence.value` がモノトニックに増加していること
3. `clearLogs` 後に `getLogBuffer().length === 0` かつ `logCount.value === 0` かつ `logSequence.value` が直前から +1 されていること
4. シーケンス signal の発火条件を `effect` で観測する。`autoScroll` トグルだけでは発火しないこと、`addLog` のたびに発火することを assert する:

   ```ts
   import { effect } from "@preact/signals";
   let fireCount = 0;
   const dispose = effect(() => {
     logSequence.value;
     fireCount += 1;
   });
   assert.strictEqual(fireCount, 1); // 初回登録時に 1 回発火
   autoScroll.value = false;
   autoScroll.value = true;
   assert.strictEqual(fireCount, 1); // autoScroll トグルでは発火しない
   addLog("info", "test");
   assert.strictEqual(fireCount, 2);
   addLog("info", "test");
   assert.strictEqual(fireCount, 3);
   dispose();
   ```

`logBuffer` をテストから参照する手段として、`getLogBuffer(): readonly LogEntry[]` を export する。`readonly LogEntry[]` 型は TypeScript の型レベル限定の不変性宣言で、ランタイム書き換えは防げないが、呼び出し側に書き換えを意図させない指針として機能する。モジュール内部の `logBuffer` は非 export、`addLog` / `clearLogs` のみが書き換える。

```ts
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}
```

テスト間で signal / `logBuffer` の状態がリセットされないため、テストファイル冒頭で `beforeEach` を以下のように設定する:

```ts
import { beforeEach } from "vitest";
beforeEach(() => {
  // clearLogs() 相当の処理で全 signal / buffer を初期化する
  // clearLogs は logSequence を +1 するため、テスト内の sequence 比較は
  // 各テスト先頭で `logSequence.peek()` を取得した基準値からの差分で行う
  // (累積カウンタの絶対値はテスト順序依存にしない)
});
```

具体的な reset 手段としては、テスト用に `__resetLogStateForTest()` を export して `logBuffer.length = 0; logCount.value = 0; logSequence.value = 0;` を実行する関数を用意するか、Vitest の `vi.resetModules()` でモジュール再読み込みを行う。後者はモック扱いになるため、前者を採用する。

### 手動確認

- devtools をビルドして起動し、Publisher + 複数 Subscriber を 1 分間動かして UI のカクつきが発生しないこと
- `autoScroll` を ON 状態で手動スクロール → OFF にし、再度 ON に戻したとき、即座に `scrollTop = 0` されないこと (新しいログが届くまで現在位置を保持)
- 1000 件超のログを蓄積した状態で `autoScroll` ON のままさらにログを追加し、先頭スクロールが正しく発火すること (MAX_LOGS 到達後の発火確認)

## CHANGES.md 記載方針

`### misc` サブセクションに `[UPDATE]` で記載する。性能改善かつ外部 API への影響なし (`logs` export は devtools 内部のみで使用)。

文面例:

```
- [UPDATE] DebugPanel のログ蓄積を破壊的配列操作 (`push` / `shift`) + シーケンス signal 分離に変更し、autoScroll effect を `autoScroll.peek()` で参照することで `autoScroll` トグル単体での再発火を抑制する (#0167)
  - @voluntas
```

## 完了条件

- `addLog` 内の `[...logs.value, entry].slice(-MAX_LOGS)` が排除されている
- `logBuffer` は signal ではないプレーン配列、`logCount` / `logSequence` が signal で公開されている
- `useSignalEffect` のオートスクロールが `logSequence` 変化単独で発火し、`autoScroll` トグル単体では発火しない
- MAX_LOGS 到達後も新規ログ追加でオートスクロールが発火する (`logSequence` がモノトニック増加するため)
- `DebugPanel` 関数本体冒頭で `void logSequence.value;` のダミー参照が入っており、MAX_LOGS 到達後も追加ごとに再レンダリングがトリガされる
- `App.tsx` の `logs.value.length` 参照が `logCount.value` に置き換わっている
- 新規単体テスト 4 件が追加されパスし、`beforeEach` の reset により独立性が確保されている
- `vp run test` が成功する
- `vp run build:devtools` が成功する
