# LOW_LEVEL_API・examples の整合性を修正する

- Created: 2026-09-06
- Completed: YYYY-MM-DD
- Branch: feature/fix-lowlevel-examples-doc
- Polished: YYYY-MM-DD

## 目的

低レベル文書の API 欠落、動かないサンプル既定値、XSS 性の描画が残る。文書間と現コードの整合が必要である。

## 現状

- `docs/LOW_LEVEL_API.md` に `subscribeTracks()` の記載がない (README は列挙する)。
- `docs/MSF.md` が古い HIGH_LEVEL_API.md へ誘導する (`0507` と連携)。
- `examples/high-level-api/index.html` の既定 URL `https://...` は現コードで即 throw される。
- `examples/high-level-api/main.ts` のログ描画が `innerHTML` で、証明書失敗の表示先が pub 固定である。

## 設計方針

1. 欠落 API を追記し、文書間の列挙を一致させる。
2. サンプル既定値を `moqt://` に直し、描画を `textContent` 構成にする。

## 完了条件

- 文書と現コードの API 列挙が一致し、サンプルが既定値で動くこと。
- `vp check` が通ること (markdownlint 対象のため)。

## 関連

- `0507` (HIGH_LEVEL_API 側の修正)
