# LID が 0 で TID が 0 以外のときも 1 オクテット形で送れる

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/change-lid-single-octet-shortest-form
- Polished: 2026-09-24

## 目的

closed の `0648-bug-loc-video-frame-marking-bits.md` で RFC 9626 §3.1 の L=0 の 1 オクテット形を入れたが、TID が 0 以外のときは §3.2 の short extension とワイヤ上区別できない受信者がいるとして 2 オクテット形を送っている。§3.1 の L=0 形は `S|E|I|D|B|TID` を 1 オクテットに載せる形であり、LID を省略しても TID と B は失われない。LID が 0 で TID が 0 以外のフレームでも 1 バイト多く送り続けており、RFC 9626 §3.1 が LID の省略に与えた「to reduce length」の意図から外れている。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarkingValue` (346 行目) は折り畳み後の `layerId === 0 && temporalLayerId === 0` のときだけ 1 オクテット形を返し (362-365 行目)、LID が 0 でも TID が 0 以外なら 2 オクテット形 (L=1、LID 0) を返す
- 同関数の JSDoc (325-328 行目) は「L=0 の 1 オクテット形が §3.2 の short extension とワイヤ上区別できず、§3.2 の受信側は下位 4 bits (B と TID) を無視し得る」を 2 オクテット形の根拠にしている
- `src/loc.ts` の `parseVideoFrameMarkingValue` (144 行目) は Length 1 でも byte1 の B / TID をワイヤのまま読む (149-153 行目)。`src/loc.prop.ts` の「VideoFrameMarking: Length=1 でも byte1 の TID / B はワイヤの値を読む」テスト (383 行目) が、L=0 かつ TID≠0 のワイヤを受理する現挙動を既に固定している
- `src/loc.test.ts` の「encodeVideoFrameMarking: LID と TID が 0 なら 1 オクテット形、それ以外は 2 オクテット形になる」テスト (366 行目) が、LID=0 / TID=1 / B=1 で `[0x09, 0x02, 0xe9, 0x00]` を固定している (380 行目)
- `src/loc.prop.ts` の Value 長 PBT (492-504 行目) は `spatialLayerId === 0 && temporalLayerId === 0 ? 3 : 4` を期待長にしている (494 行目)
- 高レベル API の既定経路 (`src/createMediaPublisher.ts` の `frameMarking`、988-994 行目) と devtools (`devtools/src/hooks/usePublisher.ts`、229 行目) は `temporalLayerId: 0` / `spatialLayerId: 0` 固定のため、本変更の影響を受けない
- `tests/e2e` に VIDEO_FRAME_MARKING のバイト列や Value 長を固定するテストは無い

## 設計方針

- `encodeVideoFrameMarkingValue` は折り畳み後の `layerId === 0` のとき常に 1 オクテット形 (L=0) を返す。TID / B を 2 オクテット形の条件から外す
- RFC 9626 §3.1 の L=0 形は `S|E|I|D|B|TID` を 1 オクテットに載せる形であり、LID と TL0PICIDX を省略しても TID は残る。§3.2 の「残り 4 bits は送信時に 0、受信時に無視する」は short extension format を選んだ送信者に課される規則であって、long extension の L=0 形を読む受信者には適用されない
- RTP では L ニブルが長さの識別子で §3.1 の L=0 形と §3.2 が同じワイヤになるが、LOC の Video Frame Marking は draft-ietf-moq-loc-04 §2.3.2.2 の length prefix で Value 長が明示される。長さが明示された Value を §3.2 の short extension と解釈する必然性は無く、LID が 0 である以上 L=0 の 1 オクテット形を選ぶのが §3.1 に忠実である
- 相互運用の実測が無いため、`CHANGES.md` の `## develop` の該当エントリに「LID が 0 で TID が 0 以外の Value が 2 オクテットから 1 オクテットになる」を `[CHANGE]` として明記する。問題が観測された場合に戻せるよう、判断の根拠 (length prefix で長さが明示されること) も同じエントリに書く
- decode 側は変更しない。Length 1 の byte1 から B / TID を読む現挙動 (`parseVideoFrameMarkingValue`) がそのまま 1 オクテット形の読み取りになり、`decodeVideoFrameMarkingAfterId` の Length 1〜4 の受理も維持する
- `src/loc.ts` の JSDoc を新しい条件に合わせる。`encodeVideoFrameMarkingValue` の 325-328 行目、`LOCPropertyId.VIDEO_FRAME_MARKING` の 60-66 行目、`VideoFrameMarking` の 86-93 行目が対象である
- 固定バイト列テストを更新する。`src/loc.test.ts` の LID=0 / TID=1 のケースは 1 オクテット形 (`[0x09, 0x01, 0xe9]`) になる。`src/loc.prop.ts` の Value 長 PBT は折り畳み後の LID が 0 なら 3、それ以外は 4 に変える
- `CHANGES.md` の 0648 のエントリ (253-259 行目) は未リリースのため、新しいエントリを足さず記述を書き換える (0648 が 0364 のエントリを書き換えたのと同じ方針)
- 対象は `src/loc.ts` / `src/loc.test.ts` / `src/loc.prop.ts` / `CHANGES.md` とする。`docs/HIGH_LEVEL_API.md` の既定経路の記述 (450 行目) は TID=0 固定の話であり変更しない

## 完了条件

- 折り畳み後の `spatialLayerId` が 0 のとき、`temporalLayerId` が 0 以外でも `encodeVideoFrameMarking` のワイヤが 1 オクテット形 (`[0x09, 0x01, byte1]`) になる。byte1 には B と TID が入る
- 折り畳み後の `spatialLayerId` が 0 以外のときは従来どおり 2 オクテット形 (`[0x09, 0x02, byte1, LID]`) になる
- 1 オクテット形 / 2 オクテット形の双方で `temporalLayerId` / `spatialLayerId` / `isBaseLayerSync` の round-trip が成立する
- `src/loc.test.ts` の固定バイト列と `src/loc.prop.ts` の Value 長 PBT が新しい長さに更新されている
- `src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の既定経路のワイヤが変わらない (LID=0 / TID=0 のため従来から 1 オクテット)
- `CHANGES.md` の `## develop` の該当エントリが新しい挙動と判断の根拠に合わせて更新されている
- `npx vp check` / `npx vp test --run` が通る

## 参照

- RFC 9626 §3.1「L=0 for 1 octet when both the LID and TL0PICIDX are omitted」「LID: ... If no scalability is used, this MUST be 0 or omitted to reduce length. When the LID is omitted, TL0PICIDX MUST also be omitted.」「It is implicitly 0 in the short extension format or when omitted in the long extension format.」。本文は 0694 で `refs/moq/rfc9626.txt` に追加する
- RFC 9626 §3.2 (Short Extension。残り 4 bits は送信時に 0、受信時に無視する)
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking。`refs/moq/draft-ietf-moq-loc-04.txt`)
- closed `0648-bug-loc-video-frame-marking-bits.md` (LID の 8 bit 化と 1 オクテット形の導入。残した課題に本件がある)
- 0694 (RFC 9626 の `refs/` 追加) / 0696 (loc-04 §2.3.2.2 の length prefix の解釈)

## 解決方法

{未着手}
