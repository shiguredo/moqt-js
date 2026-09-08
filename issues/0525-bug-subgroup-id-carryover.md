# First-Object-ID 系ヘッダでバッチ跨ぎの subgroupId が誤る

- Created: 2026-09-07
- Completed: YYYY-MM-DD
- Branch: feature/fix-subgroup-id-carryover
- Polished: 2026-09-08

## 目的

First-Object-ID 系ヘッダの subgroup で feed が分割されると、2 回目以降のオブジェクトに誤った subgroupId が付く。先頭判定のバッチ誤適用と同型の抜けであり、状態引き継ぎで修正する必要がある。

## 現状

- `src/session/stream.ts` の `processSubgroupObjects` は `resolvedSubgroupId` を関数ローカルで毎回 `header.subgroupId` から初期化し、戻り値に含めない。
- First-Object-ID 系（Subgroup ID = 先頭 Object の ID）ではデコード時に `subgroupId` が未定義のため、2 回目以降の feed では `resolvedSubgroupId ??= objectId` がそのバッチ先頭（2 件目以降）の Object ID で解決され、先頭 Object の ID ではなくなる。
- `previousObjectId` は戻り値で引き継ぐ設計のため、`resolvedSubgroupId` だけ引き継がれない同型の抜けである。
- Subgroup ID = 0 系と明示型には影響しない（ヘッダ由来値が優先され `??=` が no-op のため）。

## 設計方針

1. `resolvedSubgroupId` を戻り値に含め、呼び出し側で `previousObjectId` と同様に引き継ぐ。変更対象は `src/session/stream.ts` の `processSubgroupObjects`（戻り値追加と引数受け）に加え、中継 2 層の `src/session/incoming.ts` の `incomingProcessSubgroupObjects` と `src/session.ts` の private ラッパーおよびループ内変数の保持とする。初期値は呼び出し側で保持した値を優先し、未保持時のみ `header.subgroupId` から初期化する（`passed ?? header.subgroupId` 形）。これにより First-Object-ID 系のみが引き継ぎの恩恵を受け、明示型と Subgroup ID = 0 系は従来どおりヘッダ値が優先される。

## 完了条件

- First-Object-ID 系のバッチ跨ぎで subgroupId が先頭 Object の ID で解決されること。
- Subgroup ID = 0 系と明示型の挙動が変わらないこと。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.4.2
