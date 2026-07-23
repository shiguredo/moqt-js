# MSF Log track の payload を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-log-track-payload
- Polished: YYYY-MM-DD

## 目的

draft-ietf-moq-msf-01 §9 の Log track は catalog の `publishTracks` で `packaging: "moqlog"` を宣言できるが、payload 生成・解釈は未実装である。`refs/moq/draft-jennings-moq-log-03.txt` に従い Log track payload を実装する。

## 優先度根拠

catalog 宣言だけだと publishTracks を読んだ subscriber が実際のログ送信を始められない。診断・QoE 用途の中核機能だが、メディア再生パス自体は止まらないため Medium。

## 現状

- `PackagingType` に `"moqlog"` あり (`src/msf.ts`)
- `#0316` で catalog 上の declare 型まで対応。payload は範囲外のまま
- msf-01 §9.1: payload は [MOQLOG] Section 4 の JSON。§9.2–9.4 で namespace / Group ID / catalog 要件
- 一次資料: `refs/moq/draft-jennings-moq-log-03.txt`

## 設計方針

1. `draft-jennings-moq-log-03` の Object Data 形式に従う encode / decode を追加する (新規モジュールまたは `msf.ts` 近傍)
2. namespace / track name / Group ID / Object ID の規則 (§9.2 / §9.3) を helper 化する
3. catalog `publishTracks` の `packaging: "moqlog"` / `role: "log"` MUST 検証は既存 `validateCatalog` と整合させる
4. 高レベル API への配線は最小 (encode helper + 利用例レベルでも可)。フル自動 syslog パイプラインは本 issue の必須としない

## 完了条件

- Log entry の encode / decode round-trip がある
- namespace / Group ID 規則の helper とテストがある
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `#0349` Metrics track payload (対になる publishTracks)
