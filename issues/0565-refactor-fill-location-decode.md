# FILL_PARAMETERS / LOCATION_FILTER の再デコードを一本化する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-fill-location-decode
- Polished: {YYYY-MM-DD}

## 目的

同一 REQUEST_UPDATE に対して `decodeFillParameters` / `decodeLocationFilterParameter` を検証・上限合算・fill 評価で重複して呼んでおり、デコード結果の受け渡しで一本化する。純粋関数のため結果は同じだが、冗長で「事前検証済み」という暗黙の順序依存を生んでいる。

## 現状

- `src/session/bidi.ts` の `validateLocationAndFillParameters` が top-level LOCATION_FILTER と FILL_PARAMETERS 内側をデコードする。
- 同じ REQUEST_UPDATE について、`countIncomingRangeFilterRanges` が FILL_PARAMETERS を再度デコードして内側 Range Filter を数える。
- publish ロールの `applyPublishRequestUpdate` / `resolveFillRangeFilter` が FILL_PARAMETERS と内側 LOCATION_FILTER を再度デコードする。
- 結果として同一パラメータを最大 3 回デコードする。`decodeFillParameters` は `InvalidFilterError` を throw し得るが、再デコード箇所は検証 try/catch の外にあり、「直前に同じ入力で成功している」という前提で安全性が保たれている。

## 設計方針

1. `validateLocationAndFillParameters` がデコード結果（top-level の `LocationFilter` と FILL_PARAMETERS 内側の `Parameter[]`）を返し、上限合算と fill 評価で再利用する。
2. 検証と利用の順序依存を解消し、検証済みのデコード結果を引数で渡す構造にする。
3. 外部挙動は変えない（純粋なリファクタリング）。既存テストは変更せず通ることを確認する。

## 完了条件

- 同一 REQUEST_UPDATE での `decodeFillParameters` / `decodeLocationFilterParameter` の呼び出しが 1 回になること。
- 既存テストが変更なく通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §9.20.10 / §9.20.16
- `validateLocationAndFillParameters` / `countIncomingRangeFilterRanges` / `applyPublishRequestUpdate` / `resolveFillRangeFilter`（`src/session/bidi.ts`）
- `decodeFillParameters` / `decodeLocationFilterParameter`（`src/message/parameter.ts`）
