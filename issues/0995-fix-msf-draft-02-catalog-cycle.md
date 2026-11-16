# 参照カタログの循環検出と深さ上限を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-29 の残りを実装する。§13.7 は catalog 参照を辿る実装に循環検出と展開後の上限を MUST で要求する。

## 現状

- `getReferencedCatalogs` は `packaging: "catalog"` の track を返すだけで、辿る経路が無い
- 循環検出も深さ上限も無い

## 設計方針

- `src/msf/tracks.ts` に `assertCatalogReferenceAcyclic(root, resolve, options?)` を追加する。`resolve` は参照先 track から catalog を返すコールバック
- 同じ track を 2 回辿ったら循環として拒否する
- 深さ上限を既定 8 とし、超えたら拒否する
- 自動で参照を辿る購読経路は追加しない

## 完了条件

- 循環参照と深さ超過を拒否する。単体テストで固定する
- 正常なグラフを受理する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
