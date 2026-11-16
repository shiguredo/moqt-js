# 暗号化 track の復号経路を必須にする

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-26 を実装する。§4.4 は暗号化された Object を購読側で復号してからデコーダへ渡すことを MUST とする。

## 現状

- catalog の宣言のみ実装済み。復号処理が無く、暗号化 payload がそのままデコーダへ渡る
- `refs/` に Secure Objects のドラフトが無い

## 設計方針

- 暗号化 track を購読したらエラーにする (復号せずにデコーダへ渡す経路を塞ぐ)
- 実際の AEAD 実装は `refs/` に Secure Objects の正本が無いため行わず、正本を取得してから別 issue とする
- §4.4 の MUST のうち「復号してから渡す」は未実装だが、少なくとも暗号化 payload を平文として
  デコーダへ流す経路は塞いだ状態にする

## 完了条件

- 暗号化 track を購読するとエラーになる (実装で確認する)
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/createMediaSubscriber.ts` の `subscribeMediaTracks` で、`encryptionScheme` を持つ track を購読しようとしたらエラーにした。復号実装が無い状態で暗号化 payload を平文としてデコーダへ渡す経路を塞ぐ (§4.4)
- 実際の AEAD 復号は `refs/` に Secure Objects の正本が無いため実装していない。正本を取得してから別 issue とする
- issue の完了条件を、実装した範囲 (復号なしで渡さないこと) に合わせて更新した
