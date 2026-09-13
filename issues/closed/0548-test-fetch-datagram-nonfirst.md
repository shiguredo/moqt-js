# 非先頭の DATAGRAM + SUBGROUP_PRESENT オブジェクトのデコードをテストする

- Created: 2026-09-08
- Completed: 2026-09-14
- Branch: feature/add-fetch-datagram-nonfirst-test
- Polished: YYYY-MM-DD

## 目的

DATAGRAM ビットが立つオブジェクトは先頭・非先頭を問わず Subgroup ID フィールドを持たない。`decodeFetchSubgroupId` は `isDatagram` 判定後に早期 return するため構造上カバーされているが、非先頭（context あり）の明示テストが無く、将来の退行検知が遅れる。

## 現状

- `src/dataStream.fetch.test.ts` の DATAGRAM + SUBGROUP_PRESENT テストは先頭オブジェクト（isFirst=true、context=null）のみを検証する。
- 非先頭の混合テストは DATAGRAM に SUBGROUP_PRESENT を含まない。
- `src/dataStream.ts` の `decodeFetchObjectFields` は DATAGRAM 時に `newContext.subgroupId` へ直前の実 Subgroup ID を保持するが、これを非先頭ケースで固定していない。

## 設計方針

1. 先頭で DATAGRAM オブジェクトをデコードして context を得る。
2. 非先頭で DATAGRAM + SUBGROUP_PRESENT のオブジェクトをデコードし、Subgroup ID を消費せず Object ID / Priority / payload length が復元されることを検証する。
3. `newContext.subgroupId` が直前の実 Subgroup ID を保持することも検証する。

## 完了条件

- 非先頭 DATAGRAM + SUBGROUP_PRESENT のデコードテストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.4 / §11.4.4.1
- `decodeFetchSubgroupId` / `decodeFetchObjectFields`

## 解決方法

テストを 2 件追加した。issue の参照は draft-20 の節番号だが、現在の一次資料 draft-ietf-moq-transport-21 では §11.4.1 / §11.4.1.1 Table 9 (Fetch Object Fields) に対応するため、コメントは draft-21 の節番号に合わせている。

### 追加したテスト

`src/dataStream.fetch.test.ts` に追加した。

- 先頭 DATAGRAM オブジェクトで context を得た後、非先頭 DATAGRAM + SUBGROUP_PRESENT をデコードする。Subgroup ID vi64 を消費しないため消費バイト数がワイヤ長と一致し、Group ID (prior + delta + 1) / Object ID (絶対値) / Publisher Priority / payload length が復元されることを固定した
- 先頭を Subgroup ID 7 を持つ通常 (非 DATAGRAM) オブジェクトにし、非先頭 DATAGRAM のデコード後も `newContext.subgroupId` が 7 のまま保たれることを固定した。`decodeFetchObjectFields` は DATAGRAM のとき `subgroupId: context?.subgroupId ?? 0n` を使って直前の実 Subgroup ID を引き継ぐ。ここが 0 に落ちると後続の SUBGROUP_SAME が別 Subgroup を参照するため、非先頭での保持を明示的に検証する価値がある

### 退行検出の裏付け

`decodeFetchSubgroupId` の DATAGRAM 早期 return を `if (isDatagram && isFirst)` に変えて実行し、追加した 2 件 (および既存 3 件) が失敗することを実測した。実装は元に戻している。

### 検証

- `vp check` / `tsc --noEmit` 通過
- `vp test run`: 70 ファイル / 2,132 テスト全通過 (2 件増)
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した (テスト追加のみで機能に影響しないため)
