# MSF_COMPRESSION (0x78) の GZIP を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

D-12 を実装する。§12.1 は 0x78 でペイロード圧縮をシグナリングし、無圧縮と GZIP の双方を MUST サポートとする。

## 現状

- Property ID、scope、対応済み表は実装済み。gzip の encode / decode が無い

## 設計方針

- `CompressionStream` / `DecompressionStream` の `"gzip"` を使う
- `src/msf/compression.ts` に `compressGzip` / `decompressGzip` と property から algorithm を解決する helper を追加する
- decode 側に properties から圧縮を解決する入口を追加する (既存関数は無圧縮のまま)
- 同一 track で Track と Object の両方に 0x78 が付いたら拒否する

## 完了条件

- gzip の catalog / timeline を decode できる。単体テストで固定する
- 未知の algorithm と Track + Object 併用を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
