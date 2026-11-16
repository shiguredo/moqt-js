# connectionURI の参照先を購読の解決に使う

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-37 の残りを実装する。§5.2.37 は `connectionURI` を持つ track を購読するとき、その endpoint へ新しい接続を張る MUST を定める。

## 現状

- URI 検証は実装済み。購読側は `connectionURI` を参照しない

## 設計方針

- `src/msf/tracks.ts` に `resolveSubscribeEndpoint(track, defaultUri)` を追加し、`connectionURI` があればそれを返す
- 高レベル購読は 1 接続前提のため、別接続の確立は利用者に委ねる。JSDoc に明記する

## 完了条件

- `connectionURI` を優先し、無ければ既定 URI を返す。単体テストで固定する
- docs に別接続が必要であることを明記する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/tracks.ts` に `resolveSubscribeEndpoint(track, defaultUri)` を追加した。`connectionURI` があればその URI を返し、購読側が別 endpoint へ接続すべきことを JSDoc に書いた
- 高レベル購読は 1 接続前提のため、別接続の確立は利用者に委ねる
