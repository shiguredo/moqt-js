# 暗号化 track の復号経路を必須にする

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-26 を実装する。§4.4 は暗号化された Object を購読側で復号してからデコーダへ渡すことを MUST とする。

## 現状

- catalog の宣言のみ実装済み。復号処理が無く、暗号化 payload がそのままデコーダへ渡る
- `refs/` に Secure Objects のドラフトが無い

## 設計方針

- 復号を注入できる `decryptObject` オプションを追加する
- 暗号化 track を `decryptObject` 無しで購読したらエラーにする (復号せずに渡す経路を塞ぐ)
- 実際の AEAD 実装は正本を取得してから別 issue とする

## 完了条件

- 復号関数なしで暗号化 track を購読するとエラーになる。単体テストで固定する
- 復号関数を渡すと復号結果がデコーダへ渡る。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
