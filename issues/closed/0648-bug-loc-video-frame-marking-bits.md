# Video Frame Marking の LID を 2 bit に切り詰め、常に 2 octet で送っている

- Created: 2026-09-21
- Completed: 2026-09-24
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

- `src/loc.ts` の `encodeVideoFrameMarkingValue` / `parseVideoFrameMarkingValue` を RFC 9626 §3.1 に合わせた
  - LID は 8 bit として byte2 全体に置く (`spatialLayerId & 0xff`。値域外の負値・小数・256 以上は下位 8 bits へ折り畳む)。decode 側は `byte2 & 0x03` をやめて byte2 全体を `spatialLayerId` として復元するため、LID 4〜255 を送る実装も正しく読める
  - TL0PICIDX を送らないため、折り畳み後の LID と TID がともに 0 のときは L=0 の 1 オクテット形、それ以外は L=1 の 2 オクテット形にする。§3.1 の L=0 形は byte1 に B と TID を載せられるが、§3.2 の short extension とワイヤ上区別できず下位 4 bits を無視し得る受信側があるため、TID=0 のときだけ 1 オクテット形を選ぶ
  - Length 1〜4 の受理は維持し、LID を省略した形 (Length=1) は §3.1 の「implicitly 0 ... when omitted in the long extension format」に従い LID 0 とする
- 高レベル API の既定経路 (`createMediaPublisher` / devtools の `usePublisher`) は LID=0 / TID=0 固定のため、Value が 2 オクテットから 1 オクテットになる (送信ワイヤが変わる非互換変更)
- `LOCPropertyId.VIDEO_FRAME_MARKING` / `VideoFrameMarking` / `encodeVideoFrameMarking` / `encodeVideoFrameMarkingValue` / `parseVideoFrameMarkingValue` の JSDoc を新しい値域・L の選択・1 オクテット形と 2 オクテット形の条件に合わせて更新した (§3.3 のコーデック別 LID マッピングは利用側の責務であることも明記)
- `CHANGES.md` の `## develop` にある 0364 の `[CHANGE]` エントリを新しい挙動に書き換えた (未リリースのため同じリリースに矛盾する 2 エントリを残さない)
- `src/loc.prop.ts` の `videoFrameMarkingArb` の値域を 0〜255 に広げ、固定バイト列・8 bit の round-trip・値域外の片方向折り畳み (片方向)・折り畳みで 1 オクテット形に落ちる境界・Value 長の PBT を追加/更新した

### 検証

- `npx vp check` / `npx vp test --run` (123 files / 2590 tests) が通る
- 変異テストで、常に 2 オクテット形にする / decode の `& 0x03` 復活 / 1 オクテット形の TID 条件削除 / LID 折り畳みを `& 0x7f` にする、のいずれでも対応するテストが失敗することを確認した (レビュアーは独立に複数種を実施)
- RFC 9626 §3.1 / §3.2 の本文 (https://www.rfc-editor.org/rfc/rfc9626.txt) で LID 8 bits・L=0 の条件・§3.2 の残り 4 bits の扱いを確認した

## 残した課題

- RFC 9626 は `refs/` に無く、JSDoc / CHANGES の引用は外部本文に依存している (`refs/` への追加は別途)
- LID が 0 で TID が 0 以外のときは §3.1 上 1 オクテットにできる余地があるが、§3.2 の受信側が下位 4 bits を無視し得るため 2 オクテット形を送る (相互運用性を優先した判断)
- draft-ietf-moq-loc-04 §2.3.2.2 の「length prefix」が RFC 9626 の ID / L ニブルを含むかは仕様に明記が無く、Value (1〜4 バイト) をデータ部とみなす現解釈を維持している
