# Video Frame Marking の LID を 2 bit に切り詰め、常に 2 octet で送っている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-loc-video-frame-marking-bits
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 が参照する RFC 9626 §3.1 は LID を 8 bit と定める。現状は 2 bit に切り詰めているため、LID 4 以上のレイヤーを送る実装を LID 0〜3 と誤読する。また L=0 の 1 octet 形を送らず常に 2 octet を生成しており、非スケーラブルな映像でも 1 octet を余分に消費する。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarkingValue` は `marking.spatialLayerId & 0x03` を byte2 に置き、常に 2 バイトを返す
- `src/loc.ts` の `parseVideoFrameMarkingValue` は `byte2 & 0x03` で `spatialLayerId` を復元する
- `src/loc.ts` の `decodeVideoFrameMarkingAfterId` は Length 1〜4 を既に受理しており、Length 1 は LID 省略として `spatialLayerId` 0 を返す
- `src/loc.prop.ts` の `videoFrameMarkingArb` は `spatialLayerId` を 0〜3 に制限しており、8 bit 域が property テストで網羅されない
- closed の `0364-change-video-frame-marking-rfc9626.md` は LID の下位 2 bits マッピングを意図的に採用し、§3.3 のコーデック別 LID マッピングをスコープ外とした

## 設計方針

- `spatialLayerId` を 8 bit として扱い (値域外は下位 8 bits へ折り畳む)、その値を byte2 に置く
- TL0PICIDX を送らない現状は維持する。そのうえで LID が 0 のときは L=0 の 1 octet 形 (Value 1 バイト) を、LID が 0 以外のときは 2 octet 形を選ぶ
- decode は Length 1〜4 の受理を維持し、1 octet 形は RFC 9626 §3.1 の「It is implicitly 0 in the short extension format or when omitted in the long extension format.」に従い LID 0 とする
- 高レベル API の publisher は `spatialLayerId` 0 固定のため、既定経路が 1 octet 形に変わる (`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の frameMarking)
- `src/loc.prop.ts` の `videoFrameMarkingArb` の値域を 0〜255 に広げ、round-trip で 8 bit 域を検証する

## 完了条件

- encode した Value が RFC 9626 §3.1 のビット配置 (LID 8 bit、L=0 の 1 octet 形) と一致する
- LID 0〜255 で round-trip する
- 1 octet 形と 2 octet 形の双方を `src/loc.test.ts` の固定バイト列で検証する
- `npx vp check` / `npx vp test --run` が通る

## 参照

- RFC 9626 §3.1 「LID: Layer ID (8 bits)」「L=0 for 1 octet when both the LID and TL0PICIDX are omitted」
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking)
- RFC 9626 の本文は moqt-rs リポジトリの `refs/rfc9626.txt` で参照できる

## 解決方法

{未着手}
