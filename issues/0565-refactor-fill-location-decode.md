# FILL_PARAMETERS / LOCATION_FILTER の再デコードを一本化する

- Created: 2026-09-09
- Completed: {YYYY-MM-DD}
- Branch: feature/refactor-fill-location-decode
- Polished: 2026-09-09

## 目的

同一 REQUEST_UPDATE に対して `decodeFillParameters` / `decodeLocationFilterParameter` を検証・上限合算・fill 評価で重複して呼んでおり、デコード結果の受け渡しで一本化する。純粋関数のため結果は同じだが、冗長で「事前検証済み」という暗黙の順序依存を生んでいる。

## 現状

- `src/session/bidi.ts` の `validateLocationAndFillParameters` が top-level LOCATION_FILTER と FILL_PARAMETERS 内側をデコードする。
- 同じ REQUEST_UPDATE について、`countIncomingRangeFilterRanges`（`validateIncomingRangeFilterLimits` 経由）が FILL_PARAMETERS を再度デコードして内側 Range Filter を数える。この再デコードは検証 try/catch の内側にある。
- publish ロールの `applyPublishRequestUpdate` / `resolveFillRangeFilter` が FILL_PARAMETERS と内側 LOCATION_FILTER を再度デコードする。この再デコードは検証 try/catch の外側にあり、「直前に同じ入力で成功している」という前提で安全性が保たれている。
- 結果として同一 REQUEST_UPDATE で FILL_PARAMETERS 本体を最大 3 回、内側 LOCATION_FILTER を最大 4 回デコードする（`decodeFillParameters` が内側 LOCATION_FILTER を `decodeLocationFilterParameter` でデコードするため）。

## 設計方針

1. `validateLocationAndFillParameters` がデコード結果（top-level の `LocationFilter`、FILL_PARAMETERS 本体の内側 `Parameter[]`、内側の `LocationFilter`）を返し、上限合算と fill 評価で再利用する。内側 LOCATION_FILTER も返すことで、`resolveFillRangeFilter` が `decodeLocationFilterParameter` を再度呼ばないようにする。
2. 上限合算（`countIncomingRangeFilterRanges` / `validateIncomingRangeFilterLimits`）のシグネチャを、デコード済みの内側配列を受け取る形に変更する。
3. 検証と利用の順序依存を解消し、検証済みのデコード結果を引数で渡す構造にする。
4. 外部挙動は変えない（純粋なリファクタリング）。既存テストは変更せず通ることを確認する。

## 完了条件

- 受信 REQUEST_UPDATE 経路で `decodeFillParameters` / `decodeLocationFilterParameter` の呼び出しが `validateLocationAndFillParameters` の 1 箇所に集約され、上限合算と fill 評価が返されたデコード結果を再利用していること（モック/スタブを使わないため、コードレビューで確認する）。
- 既存テストが変更なく通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-21 §9.20.10 / §9.20.16 / §9.1.6
- `validateLocationAndFillParameters` / `countIncomingRangeFilterRanges` / `validateIncomingRangeFilterLimits` / `applyPublishRequestUpdate` / `resolveFillRangeFilter`（`src/session/bidi.ts`）
- `decodeFillParameters` / `decodeLocationFilterParameter`（`src/message/parameter.ts`）
- `issues/closed/0541-bug-fill-parameters-no-fill-stream.md`（`applyPublishRequestUpdate` / `resolveFillRangeFilter` の追加元）
