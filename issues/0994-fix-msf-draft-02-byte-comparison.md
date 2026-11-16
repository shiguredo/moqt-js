# 名前比較をバイト単位にし、MOQT 受信名の不正 UTF-8 を拒否する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-19 の残りを実装する。§11.2.3 は名前をバイト完全一致で比較すると定めるが、実装は JS 文字列で比較し、MOQT 受信名を非 fatal な `TextDecoder` で文字列化している。

## 現状

- `src/fullTrackName.ts` の `fullTrackNameKey` は UTF-16 コードユニット長の文字列キー
- MOQT から名前を受ける経路は非 fatal な decode のため、不正 UTF-8 が U+FFFD 置換で catalog の有効な文字列と衝突し得る

## 設計方針

- MOQT から受信する Track Namespace / Track Name の decode を fatal UTF-8 にし、不正バイト列を拒否する
- 名前の比較キーを UTF-8 バイト列 (長さ + 内容) から作る
- catalog の名前は §11.2.1 で検証済みのため、比較結果は変わらない

## 完了条件

- 不正 UTF-8 の受信名を拒否する。単体テストで固定する
- 比較キーが UTF-8 バイト列に基づく。単体テストで固定する
- 既存の重複検出の挙動が変わらない
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
