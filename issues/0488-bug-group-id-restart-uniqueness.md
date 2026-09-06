# Publisher の Group ID が再起動で 0 に戻り MSF §6.1 MUST に違反する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-group-id-restart
- Polished: YYYY-MM-DD

## 目的

MSF §6.1 は再起動時の開始 Group ID が過去の全 Group ID を上回る MUST を定める。毎回 0 からの採番では購読側の継続性が壊れる。

## 現状

- `src/createMediaPublisher.ts` は音声・映像とも Group ID を 0 から採番する。
- `src/msf.ts` の `createInitialGroupId` (Unix epoch ミリ秒起点) がテスト以外で未使用である。
- 映像は最初のキーフレームで加算してから送信するため Group 0 が未使用になる不整合もある。

## 設計方針

1. `createInitialGroupId` を Publisher の初期値に使い、再起動で単調性を保つ。
2. Group 0 未使用の不整合を合わせて正す。

## 完了条件

- 再起動後の開始 Group ID が過去を上回ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-msf-01 §6.1 / §6.2
