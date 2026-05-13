# MSF の Media / Event Timeline で GZIP 圧縮を扱えるようにする

Created: 2026-04-04
Completed: 2026-04-04
Model: Composer 2 Fast

## 概要

`draft-ietf-moq-msf-00` では、Media Timeline（Section 7.1）および Event Timeline（Section 8.1）の JSON ドキュメントを **GZIP 圧縮してよい（MAY）** とされている。現状の `src/msf.ts` は非圧縮の UTF-8 JSON のみを `encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` で扱っており、ドラフトが許容する転送形式をカバーしていない。

## RFC 根拠

`draft-ietf-moq-msf-00` Section 7.1（Media Timeline track payload）および Section 8.1（Event Timeline data format）に、以下の記述がある。

> "This document MAY be compressed using GZIP [GZIP]."

相互運用のため、送信側で gzip 済みペイロードを生成でき、受信側で gzip 済みバイト列を解凍して既存の JSON パースに渡せることが望ましい。

参考: https://www.ietf.org/archive/id/draft-ietf-moq-msf-00.html

## 現状

- `encode*` は `TextEncoder` で JSON バイト列を出力するのみ。
- `decode*` は入力全体を UTF-8 テキストとして `JSON.parse` するのみ。
- ブラウザでは `CompressionStream` / `DecompressionStream`（`gzip`）による実装が可能だが、未使用。

## 提案する実装方針

1. **gzip 判定**: ペイロード先頭が `0x1F 0x8B`（gzip マジック）かどうかで圧縮有無を判定する。
2. **非同期 API**: 圧縮 API が非同期のため、既存の同期 `encode*` / `decode*` を非同期 API に置き換える。後方互換性は考慮しない（CLAUDE.md 方針）。
3. **内部処理**: `Blob#stream()` → `CompressionStream('gzip')` / `DecompressionStream('gzip')` → `Response#arrayBuffer()` で `Uint8Array` を得る。
4. **環境**: `CompressionStream` / `DecompressionStream` が存在しない環境では、gzip を要求するエンコードや gzip ペイロードのデコードは明示的に失敗させる（または別 issue で pako 等のフォールバックを検討）。
5. **テスト**: gzip のラウンドトリップを Vitest で検証する。対象ランタイムは `CompressionStream` / `DecompressionStream` をサポートする環境（Node.js 18+ / モダンブラウザ）とし、CI でも必ず実行する。

## 受け入れ基準

- Media / Event Timeline の両方について、gzip エンコード → gzip デコードのラウンドトリップで元の論理内容と一致すること。
- gzip エンコード結果の先頭が gzip マジック（`0x1F 0x8B`）であること。
- 非圧縮ペイロードのデコードが従来どおり動作すること（既存テストが通ること）。
- CI 上で gzip ラウンドトリップテストが実行され、パスすること。

## 解決方法

`encodeMediaTimeline` / `decodeMediaTimeline` / `encodeEventTimeline` / `decodeEventTimeline` を非同期 API に変更し、`gzip: true` オプション付きエンコードと gzip マジックによる自動デコードを追加した。

内部実装では `Blob#stream()` と `CompressionStream('gzip')` / `DecompressionStream('gzip')` を使って圧縮・展開し、未圧縮ペイロードは従来どおり JSON として処理する。

テストでは Media / Event Timeline の両方について gzip ラウンドトリップと gzip マジックを検証し、既存の非圧縮デコード系テストも非同期 API に更新した。
