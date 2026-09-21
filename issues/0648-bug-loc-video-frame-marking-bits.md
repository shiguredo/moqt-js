# Video Frame Marking の LID を 2 bit に切り詰め、常に 2 octet で送っている

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-loc-video-frame-marking-bits
- Polished: 2026-09-21

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 が参照する RFC 9626 §3.1 は LID を 8 bit と定める。現状は encode が `spatialLayerId` を下位 2 bit に折り畳むため LID 4〜255 の値を失い、parse が `byte2 & 0x03` で読むため LID 4〜255 を送る実装を LID 0〜3 と誤読する。また LID を含めない場合に使える 1 octet 形 (RFC 9626 §3.1 の L=0) を送らず、常に 2 octet を生成しているため、非スケーラブルな映像でも 1 octet を余分に消費する。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarkingValue` は `marking.spatialLayerId & 0x03` を byte2 に置き、常に 2 バイトを返す。JSDoc も「Long Extension 2 オクテット形 (L=1、TL0PICIDX 省略) 準拠」「spatialLayerId (値域 0-3) を下位 2 bits にマッピング」と書いており、実装と一致している
- `src/loc.ts` の `parseVideoFrameMarkingValue` は `byte2 & 0x03` で `spatialLayerId` を復元する
- `src/loc.ts` の `decodeVideoFrameMarkingAfterId` は Length 1〜4 を既に受理しており、Length 1 は LID 省略として `spatialLayerId` 0 を返す
- `src/loc.prop.ts` の `videoFrameMarkingArb` は `spatialLayerId` を 0〜3 に制限しており、8 bit 域が property テストで網羅されない。同ファイルには 2 bit 折り畳みと常に 2 octet であることを固定するテストが並んでいる (encode の下位 2 bits、decode の 0x04〜0x07 / 0xff → 0〜3、値域外の折り畳み 4→0 / 255→3 / -1→3、`encodeVideoProperties` 経由の折り畳み、TID=0 のワイヤ `[0x09, 0x02, 0xe0, 0x00]`、Length=3 / 4 の byte2 解釈)。`src/loc.test.ts` には delta ワイヤ `[0x09, 0x02, 0xe0, 0x00, 0x07, 0x84, 0xd2]` と Value `[0xe0, 0x00]` 前提のコメントがある
- closed の `0364-change-video-frame-marking-rfc9626.md` は LID の下位 2 bits マッピングを意図的に採用し、§3.3 のコーデック別 LID マッピングをスコープ外とした。`CHANGES.md` の `## develop` にある 0364 の `[CHANGE]` エントリにも「LID の下位 2 bits のみを復元する」と記録されている
- RFC 9626 の本文はこのリポジトリの `refs/` には無く、引用は実装の JSDoc と外部の RFC 本文に依存している

## 設計方針

- `spatialLayerId` を 8 bit として扱い、値を byte2 全体に置く (値域外は下位 8 bits へ折り畳む)。`parseVideoFrameMarkingValue` の `byte2 & 0x03` を廃し、byte2 全体を `spatialLayerId` として復元する
- L は TL0PICIDX の有無で決まる (RFC 9626 §3.1)。TL0PICIDX を送らない本実装では、LID と TID がともに 0 のときは L=0 の 1 octet 形 (Value 1 バイト、残りの 4 bit は 0) を選び、それ以外は L=1 の 2 octet 形 (LID を載せる) にする。TID が 0 以外のときに 1 octet 形にすると §3.2 の短縮形の残り 4 bit が 0 固定のため TID と B が落ちるので、TID=0 を 1 octet 形の条件に含める
- decode は Length 1〜4 の受理を維持し、1 octet 形は RFC 9626 §3.1 の「It is implicitly 0 in the short extension format or when omitted in the long extension format.」に従い LID 0 とする。L=1 で LID が 0 の 2 octet 形も受理する
- 高レベル API の publisher は `spatialLayerId` 0 かつ `temporalLayerId` 0 固定のため、既定経路が 1 octet 形に変わる (`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の frameMarking)。エンコード結果が 4 バイトから 3 バイトになり、送信ワイヤが変わる非互換変更である
- `src/loc.ts` の `LOCPropertyId.VIDEO_FRAME_MARKING` / `VideoFrameMarking` / `encodeVideoFrameMarking` / `encodeVideoFrameMarkingValue` の JSDoc を、8 bit の値域・L の選び方・1 octet 形と 2 octet 形の条件に合わせて更新する
- `CHANGES.md` の `## develop` にある 0364 の `[CHANGE]` エントリは「下位 2 bits のみを復元する」と書いており本変更で誤りになるため、新しいエントリを足さずに記述を書き換える (未リリースのため同じリリースに矛盾する 2 エントリを残さない)
- `src/loc.prop.ts` の `videoFrameMarkingArb` の値域を 0〜255 に広げ、round-trip で 8 bit 域を検証する。2 bit 折り畳みと常に 2 octet を固定している既存テストの期待値を新しい値域と octet 長に更新し、値域外 (256 → LID 0) の片方向の折り畳みも 1 例固定する

## 完了条件

- encode した Value が RFC 9626 §3.1 のビット配置と一致する (LID は 8 bit。LID と TID が 0 なら L=0 の 1 octet 形、それ以外は L=1 の 2 octet 形)
- `spatialLayerId` 0〜255 と `temporalLayerId` 0〜7 の round-trip が成立する (値域外の折り畳みは片方向で、round-trip の対象外)
- 1 octet 形と 2 octet 形の双方を `src/loc.test.ts` の固定バイト列で検証する (LID=0 / TID=0 は `[0x09, 0x01, byte1]`、LID≠0 は `[0x09, 0x02, byte1, LID]` の長さまで固定する)
- `src/loc.ts` の関連 JSDoc と `CHANGES.md` の `## develop` の 0364 エントリが新しい挙動に合わせて更新されている
- 追加したテストと既存テストが通る (`npx vp check` / `npx vp test --run`)

## 参照

- RFC 9626 §3.1 「LID: Layer ID (8 bits)」「L=0 for 1 octet when both the LID and TL0PICIDX are omitted」「It is implicitly 0 in the short extension format or when omitted in the long extension format.」(本文はこのリポジトリの `refs/` に無いため https://www.rfc-editor.org/rfc/rfc9626.txt を参照する)
- RFC 9626 §3.2 (Short Extension。残り 4 bit は送信時に 0、受信時に無視する)
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking。`refs/moq/draft-ietf-moq-loc-04.txt`)

## 解決方法

{未着手}
