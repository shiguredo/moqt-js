# 読まれていない decodedFrames の signal とフレームログ記録を削除する

- Created: 2026-11-10
- Completed: 2026-11-10
- Branch: feature/remove-devtools-decoded-frames
- Polished: 2026-11-10

## 目的

`devtools/src/webcodecs-devtools/signals.ts` の `decodedFrames` は外部から読む箇所が無く、フレームログの記録が復号フレーム 1 枚ごとに走り、クリアはリセット時とクリア操作時に走っている。死にコードを削除し、復号フレームを処理する経路から不要な配列操作を無くす。

## 現状

- `decodedFrames` は `signal<FrameLog[]>([])` として定義され、書く場所は 3 つある
  - `handleDecodedFrame` のフレームログ追加 (100 件に切り詰めながら `decodedFrames.value` を作り直す)
  - `resetEncoder` と `clearFrameLogs` のクリア
- 外部から読む箇所は無く、書き込み処理の中の自己読み取り (`const frames = decodedFrames.value;`) だけである。`FrameLogPanel` は `encodedFrames` だけを描画しており、`decodedFrames` を読むコンポーネントは無い
- `FrameLog` 型自体は `encodedFrames` でも使うため残す
- `handleDecodedFrame` は復号フレーム 1 枚ごとに `allocationSize()` を呼んで `frameSize` を求め、その値を `decodedFrames` に積んでいる。統計 (`decoderStats`) の `totalBytes` にも `frameSize` を使っており、統計側の利用は残す

## 設計方針

- `decodedFrames` の宣言、`handleDecodedFrame` のフレームログ追加、`resetEncoder` / `clearFrameLogs` のクリアを削除する
- `decoderStats` の更新とキャンバスへの描画は残す
- `clearFrameLogs` の名前は `encodedFrames` だけを消すことになるが、公開している関数名を変えると呼び出し側 (`FrameLogPanel`) に波及する。呼び出し側の意味は「フレームログをクリアする」で変わらないため、名前はそのままにし、対象が符号化のログだけであることを JSDoc に書く

### 対象外

- `encodedFrames` の保持件数 (100 件) や `FrameLog` の形は変えない

## 完了条件

- `rg -n decodedFrames devtools` が 0 件になること
- `devtools/src/webcodecs-devtools/signals.ts` の `handleDecodedFrame` から `decodedFrames` への追加が消え、`decoderStats` の更新と描画が残っていること
- `vp check` / `vp exec tsc --noEmit -p devtools` / `vp test run` が通ること

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 解決方法

`devtools/src/webcodecs-devtools/signals.ts` から、読まれていない復号のフレームログを削除した。

- `decodedFrames` の signal 宣言を削除した
- `handleDecodedFrame` からフレームログの追加 (100 件に切り詰める配列操作) を削除した。`decoderStats` の更新と `decoded-canvas` への描画は残した
- `resetEncoder` と `clearFrameLogs` から `decodedFrames.value = []` を削除した。`clearFrameLogs` の JSDoc を「符号化のフレームログをクリアする」に直し、復号のフレームログを保持していないことを書いた
- 検証: `rg -n decodedFrames devtools` が 0 件、`vp check` / `vp exec tsc --noEmit -p devtools` / `vp test run` (276 ファイル、5073 テスト) が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新していない (`CODEBASE.md` の特別ルール)。

## 参照

- `devtools/src/webcodecs-devtools/signals.ts` の `FrameLog` / `encodedFrames` / `decodedFrames` / `handleDecodedFrame` / `resetEncoder` / `clearFrameLogs`
- `devtools/src/webcodecs-devtools/components/FrameLogPanel.tsx`
