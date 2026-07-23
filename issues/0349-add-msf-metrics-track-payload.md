# MSF Metrics track の payload を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-metrics-track-payload
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §10 の Metrics track は catalog の `publishTracks` で `packaging: "moqmetrics"` を宣言できるが、payload 生成・解釈は未実装である。`refs/moq/draft-jennings-moq-metrics-02.txt` に従い Metrics track payload を実装する。

## 優先度根拠

Log track と同様、catalog 宣言だけでは定量メトリクスを送れない。メディア再生パス自体は止まらないため Medium。

## 現状

- `PackagingType` に `"moqmetrics"` あり (`src/msf.ts`)
- `#0316` で catalog 上の declare 型まで対応。payload は範囲外のまま
- msf-01 §10.1–10.5: [MOQMETRICS] 形式、namespace / Group ID、catalog 要件、well-known event timeline types
- 一次資料: `refs/moq/draft-jennings-moq-metrics-02.txt`

## 設計方針

1. `draft-jennings-moq-metrics-02` のデータモデルに従う encode / decode を追加する
2. namespace / track name / Group ID / Object ID の規則 (§10.2 / §10.3) を helper 化する
3. catalog `publishTracks` の `packaging: "moqmetrics"` / `role: "metrics"` MUST 検証は既存と整合させる
4. 高レベル API へのフル自動配線は必須としない

## 完了条件

- Metrics payload の encode / decode round-trip がある
- namespace / Group ID 規則の helper とテストがある
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `#0348` Log track payload (対になる publishTracks)
