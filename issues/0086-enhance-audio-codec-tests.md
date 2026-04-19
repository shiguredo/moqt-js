# audio 向けの codec config / LOC audio properties のテストを整備する

Created: 2026-04-19
Model: Opus 4.7

## 概要

audio 対応の回帰検出を video と同水準に整えるため、純粋関数で完結するテストを追加する。

CLAUDE.md の方針に従い、モック / スタブは利用しない。このため `AudioEncoder` / `AudioDecoder` 本体 (`AudioEncoderWrapper` / `AudioDecoderWrapper`) はブラウザ API に依存するためテスト対象外とする。代わりに以下を整備する。

1. `src/codec/config.ts` の `getAudioEncoderConfig` / `getAudioDecoderConfig` の単体テスト。
2. `src/loc.ts` の `encodeAudioProperties` / `decodeAudioProperties` のラウンドトリップテスト (draft-02 の ID 衝突バグ対象は除外)。

## 根拠

- `src/codec/config.ts` は純粋関数で、opus / aac のそれぞれに対して WebCodecs 互換の config を返す責務を持つ。codec 名の文字列や sampleRate / numberOfChannels のマッピングに対する回帰検出が不足している。
- `src/loc.prop.ts` には Video 向けのプロパティテストは揃っているが、Audio については `AudioLevel` 単独テストだけがあり、`AudioProperties` のラウンドトリップテストが存在しない (行 150-153 のコメントで除外理由を記載済み)。`timestamp` / `timescale` のみを含むケースはバグ対象外なのでラウンドトリップ検証を追加できる。
- `audioLevel` を含む `AudioProperties` は draft-02 の仕様バグ (ID 衝突) により、decode 側で TIMESTAMP として誤認される。この挙動を固定化するテストを追加し、仕様改訂時に気づけるようにする。

## 該当箇所

- `src/codec/config.ts` (`getAudioEncoderConfig` / `getAudioDecoderConfig`)
- `src/loc.ts` (`encodeAudioProperties` / `decodeAudioProperties`)
- `src/loc.prop.ts` (テスト追加先)

## 修正方針

1. `src/codec/config.test.ts` を新設する。
   - opus / aac のそれぞれで encoder / decoder の config が期待どおりであること
   - `sampleRate` / `channels` のデフォルト適用が効くこと
2. `src/loc.prop.ts` に以下を追加する。
   - 空の `AudioProperties` が空バイト列にエンコードされること
   - `audioLevel` を除く `AudioProperties` (`timestamp`、`timescale`) のラウンドトリップ
   - `audioLevel` を含む `AudioProperties` は decode 時に TIMESTAMP として誤認されることを固定化する回帰テスト

## 検証

- `vp run build` (vite build + tsc) が通ること。
- `vitest run` で既存 + 新規テストがすべて通ること。
- e2e 動作確認は今回は対象外。
