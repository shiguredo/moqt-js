# 読まれていない decodedFrames の signal とフレームログ記録を削除する

- Created: 2026-11-10
- Completed: {YYYY-MM-DD}
- Branch: feature/remove-devtools-decoded-frames
- Polished: {YYYY-MM-DD}

## 目的

`devtools/src/webcodecs-devtools/signals.ts` の `decodedFrames` は書き込みだけで読み取りが無く、フレームログの記録とクリアが毎フレーム走っている。死にコードを削除し、復号フレームを処理する経路から不要な配列操作を無くす。

## 現状

- `decodedFrames` は `signal<FrameLog[]>([])` として定義され、書く場所は 3 つある
  - `handleDecodedFrame` のフレームログ追加 (100 件に切り詰めながら `decodedFrames.value` を作り直す)
  - `resetEncoder` と `clearFrameLogs` のクリア
- 読み取りは無い。`FrameLogPanel` は `encodedFrames` だけを描画しており、`decodedFrames` を読むコンポーネントは無い
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

## 参照

- `devtools/src/webcodecs-devtools/signals.ts` の `FrameLog` / `encodedFrames` / `decodedFrames` / `handleDecodedFrame` / `resetEncoder` / `clearFrameLogs`
- `devtools/src/webcodecs-devtools/components/FrameLogPanel.tsx`
