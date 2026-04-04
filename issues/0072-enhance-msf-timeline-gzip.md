# MSF の Media / Event Timeline で GZIP 圧縮を扱えるようにする

Created: 2026-04-04
Model: GPT-5.2

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
2. **非同期 API**: 圧縮 API が非同期のため、`encodeMediaTimelineAsync` / `decodeMediaTimelineAsync` および Event Timeline 向けの対応関数を追加する。既存の同期 API は非圧縮 JSON 用として維持するか、互換性の方針を決める。
3. **内部処理**: `Blob#stream()` → `CompressionStream('gzip')` / `DecompressionStream('gzip')` → `Response#arrayBuffer()` で `Uint8Array` を得る。
4. **環境**: `CompressionStream` / `DecompressionStream` が存在しない環境では、gzip を要求するエンコードや gzip ペイロードのデコードは明示的に失敗させる（または別 issue で pako 等のフォールバックを検討）。
5. **テスト**: gzip のラウンドトリップを Vitest で検証する。API が無い環境では該当テストをスキップするなど、CI を壊さないこと。

## 受け入れ基準（案）

- gzip 圧縮した Media / Event Timeline ペイロードをデコードして、非圧縮と同一の論理内容になること。
- 非圧縮ペイロードのデコードが従来どおり動作すること（既存テストが通ること）。
