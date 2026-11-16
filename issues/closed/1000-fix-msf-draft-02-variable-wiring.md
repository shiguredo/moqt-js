# catalog の変数置換を高レベル購読に配線する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-18 を実装する。§11.5.2 は catalog の変数を URI fragment の parameter で置換し、置換後の catalog を再検証する MUST を定める。

## 現状

- `resolveCatalogVariables` は公開 API にも高レベル購読にも配線されていない

## 設計方針

- `createMediaSubscriber` のオプションに `catalogVariables` を追加し、受信した catalog を置換してから適用する
- fragment から変数 map を作る helper `catalogVariablesFromFragment(fragment)` を追加する
- `resolveCatalogVariables` を公開 API に追加する

## 完了条件

- fragment から変数 map を作れる。単体テストで固定する
- 置換後の catalog で track を解決する。単体テストで固定する
- 不正な置換結果はエラーになる。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/fragment.ts` に `catalogVariablesFromFragment` を追加した。msf fragment の parameter から変数 map を作り、予約パラメータ (cat / connection / *-range) は除外し、同じ key は最初の値を使う
- `MediaSubscriberOptions` に `catalogVariables` を追加し、受信した full catalog を `resolveCatalogVariables` で置換してから一意性検証と適用を行うようにした。delta の適用結果にも置換を適用する
- `resolveCatalogVariables` と `catalogVariablesFromFragment` を公開 API に追加した
- fragment からの変数作成、置換後の track 解決、literal の `%` の拒否を単体テストで固定した
