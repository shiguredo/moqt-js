# MSF Log track の payload を実装する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/add-msf-log-track-payload
- Polished: 2026-07-27

## 目的

draft-ietf-moq-msf-01 §9 の Log track は catalog の `publishTracks` で `packaging: "moqlog"` を宣言できるが、payload 生成・解釈は未実装である。`refs/moq/draft-jennings-moq-log-03.txt` に従い Log track payload を実装する。

## 優先度根拠

catalog 宣言だけだと publishTracks を読んだ subscriber が実際のログ送信を始められない。診断・QoE 用途の中核機能だが、メディア再生パス自体は止まらないため Medium。

## 現状

- `PackagingType` に `"moqlog"` あり (`src/msf.ts:50`)。`RESERVED_TRACK_ROLES` に `"log"` あり (`src/msf.ts:76`)
- `#0316` (closed) で catalog 上の declare 型まで対応。payload は範囲外のまま
- msf-01 §9.1: payload は [MOQLOG] Section 4 の JSON (L3118 MUST 参照)
- msf-01 §9.2: namespace / track name 形式。**§9.2 には "TODO: Finalize on track naming" (L3123) があり未確定**。本文は [MOQLOG] Section 3 の形式を MUST とする
- msf-01 §9.3: Group ID = timestamp を 62-bit に truncate（**Unix epoch からのマイクロ秒**、L3143-3145）。Object ID = 同一マイクロ秒内で連番
- msf-01 §9.4: packaging="moqlog" + role="log" の双方 MUST
- [MOQLOG] §4: payload は全フィールド optional の JSON object (severity / timestamp / pri / hostname / appname / procid / msgid / msg + 未知フィールドは structured data)
- [MOQLOG] §3: Track Name は log priority level の 1 バイト (0=Emergency 〜 7=Debug)。payload の severity 文字列 ("Emergency"〜"Debug") と Track Name のバイナリ優先度は syslog severity 規約で対応する
- 一次資料: `refs/moq/draft-jennings-moq-log-03.txt`（**Expires: 2026-04-23 で期限切れ**。後継 draft なし。msf-01 が MUST 参照するため現時点で最新の参照仕様）
- **timestamp epoch の矛盾**: [MOQLOG] §4 は payload timestamp を "microseconds since 1 Jan 1972 (NTP Era zero)" と定義するが、msf-01 §9.3 は Group ID を "microseconds since the Unix epoch (1970)" と定義する。[MOQLOG] §7 の例も本文と数値が不整合（timestamp=3155587200 は 1900 起点の秒としか一致しない）。本 issue では **Group ID は msf-01 §9.3 に従い Unix epoch マイクロ秒**、**payload timestamp は [MOQLOG] §4 の記述に従う**（[MOQLOG] 内部の不整合は実装時にコードコメントで注記する）
- `validatePackagingSpecificRules` (`src/msf.ts:1423-1469`) は `mediatimeline` / `eventtimeline` のみ処理し、`moqlog` 分岐は未実装
- 既存の `createInitialGroupId()` (`src/msf.ts:2469`) はメディアトラック用の `Date.now()` ベースであり、Log track の timestamp ベース Group ID とは意味が異なる

## 設計方針

1. [MOQLOG] Section 4 の Object Data 形式に従う encode / decode を新規モジュール `src/moqlog.ts` に追加する（`msf.ts` は 2500 行超で肥大化しており、#0349 Metrics も対モジュール `src/moqmetrics.ts` に分離する想定）
2. `LogEntry` の型は全フィールド optional の interface とし、未知フィールドは structured data として保持する（round-trip で破棄しない）
3. Group ID / Object ID の規則 (§9.3) を helper 化する。Group ID は Unix epoch マイクロ秒を 62-bit に truncate する（msf-01 §9.3 に従う）。既存の `createInitialGroupId()` とは命名・責務を分離する
4. §9.2 の namespace / track name 形式は **仕様が TODO 付きのため暫定対応** とする。helper は [MOQLOG] Section 3 の現行テキストに従うが、変更を隔離できる設計にする（仕様確定時に helper 内部の修正で済むようにする）
5. catalog `publishTracks` の `packaging: "moqlog"` + `role: "log"` MUST 検証を `validatePackagingSpecificRules` に **新規追加** する（既存検証はない）
6. 高レベル API への配線は最小限（encode helper + 利用例レベル）。フル自動 syslog パイプラインは本 issue の範囲外

## 完了条件

- `LogEntry` interface と encode / decode の round-trip テストがある（[MOQLOG] §7 の例をテストベクタに含む）
- Group ID / Object ID helper とテストがある（Unix epoch マイクロ秒基準）
- §9.2 の namespace / track name helper がある（暫定対応である旨をコードコメントに明記）
- `validatePackagingSpecificRules` に `moqlog` + `role: "log"` の MUST 検証がある
- `CHANGES.md` の `## develop` に `[ADD]` を追記する
- `vp run test` / `vp run build` が pass する

## 関連

- `#0316` (closed) catalog 型までの先行対応
- `#0349` Metrics track payload (対になる publishTracks)
