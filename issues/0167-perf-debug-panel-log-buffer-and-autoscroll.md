# DebugPanel のログ蓄積を改善し autoscroll の再発火を抑制する

Created: 2026-05-11
Model: Opus 4.7

## 概要

`DebugPanel.tsx:addLog` は `logs.value = [...logs.value, entry].slice(-MAX_LOGS);` で実装されている。各ログ追加で配列全体のコピー + slice が走り O(N)。MOQT のオブジェクト到着頻度 (30 fps × 複数 Subscriber) では性能劣化が顕在化する。

加えて `useSignalEffect` がログ追加のたびに発火して `scrollTop = 0` するため、ユーザーが autoScroll を OFF にしたタイミングや手動スクロール直後にも先頭に強制復帰する経路がある。

## 根拠

- `DebugPanel.tsx:logs.value = [...logs.value, entry].slice(-MAX_LOGS)` は O(N)
- `useSignalEffect(() => { ... scrollTop = 0; })` が `logs.value.length` 変化のたびに発火
- MAX_LOGS = 1000 で秒間 60 ログ追加すれば 60 × 1000 = 60,000 要素/秒コピー
- `logs.value` 参照差し替えは全ての `logs.value.map` / `logs.value.length` 購読箇所を再評価させる

## 修正方針

1. ログを `useRef<LogEntry[]>` または「リングバッファ」で管理し、追加は push 1 回 + 超過時 shift 1 回で済むようにする
2. UI 表示用には `count` だけ Signal 化、内容は ref からアクセスする (もしくは `Signal<readonly LogEntry[]>` でラップを残しつつ slice しない設計)
3. autoScroll の `useSignalEffect` で `autoScroll.value` は `untracked()` で読み、`logs.value.length` だけを購読する
4. DebugPanel が閉じている (`isDebugPanelOpen.value === false`) 間はログ蓄積を一時停止する選択肢も検討する (機能変更につき要相談)

## 影響範囲

- `devtools/src/components/DebugPanel.tsx`
- `devtools/src/components/DebugPanel.test.ts` (新規追加候補)

## テスト戦略

- `vp run test` で全テストがパスすること
- ログ追加のベンチを軽く追加 (10,000 追加でも数 ms オーダー)
- 手動: パネル開いたまま 1 分間 MOQT 配信 → UI がカクつかないことを確認

## CHANGES.md 記載方針

- `### misc` サブセクションに `[UPDATE]` で記載する (性能改善)

## 完了条件

- ログ追加の計算量が O(N) から実質 O(1) に低下する
- `useSignalEffect` の autoScroll が `autoScroll.value` 変化単独では発火しない
- 全テストパス
