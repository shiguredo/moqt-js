# LID が 0 で TID が 0 以外のときも 1 オクテット形で送る

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/change-lid-single-octet-shortest-form
- Polished: 2026-10-26

## 目的

closed の `0648-bug-loc-video-frame-marking-bits.md` で RFC 9626 §3.1 の L=0 の 1 オクテット形を入れたが、TID が 0 以外のときは §3.2 の short extension とワイヤ上区別できない受信者がいるとして 2 オクテット形を送っている。§3.1 の L=0 形は `S|E|I|D|B|TID` を 1 オクテットに載せる形であり、LID を省略しても TID と B は失われない。LID が 0 で TID が 0 以外のフレームでも 1 バイト多く送り続けており、LID が 0 のときに選べる L=0 の 1 オクテット形を使っていない。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarkingValue` は折り畳み後の `layerId === 0 && temporalLayerId === 0` のときだけ 1 オクテット形を返し、LID が 0 でも TID が 0 以外なら 2 オクテット形 (L=1、LID 0) を返す
- 同関数の JSDoc は「L=0 の 1 オクテット形が §3.2 の short extension とワイヤ上区別できず、§3.2 の受信側は下位 4 bits (B と TID) を無視し得る」を 2 オクテット形の根拠にしている
- `src/loc.ts` の `parseVideoFrameMarkingValue` は Length 1 でも byte1 の B / TID をワイヤのまま読む。`src/loc.prop.ts` の「VideoFrameMarking: Length=1 でも byte1 の TID / B はワイヤの値を読む」テストが、L=0 かつ TID≠0 のワイヤを受理する現挙動を既に固定している
- `src/loc.test.ts` の「encodeVideoFrameMarking: LID と TID が 0 なら 1 オクテット形、それ以外は 2 オクテット形になる」テストが、LID=0 / TID=1 / B=1 で `[0x09, 0x02, 0xe9, 0x00]` を固定している
- `src/loc.prop.ts` の Value 長 PBT は `spatialLayerId === 0 && temporalLayerId === 0 ? 3 : 4` を期待長にしている
- 高レベル API の既定経路 (`src/createMediaPublisher.ts` の `frameMarking` と `devtools/src/hooks/usePublisher.ts` の `frameMarking`) は `temporalLayerId: 0` / `spatialLayerId: 0` 固定のため、本変更の影響を受けない
- `tests/e2e` に VIDEO_FRAME_MARKING のバイト列や Value 長を固定するテストは無い

## 設計方針

- `encodeVideoFrameMarkingValue` は折り畳み後の `layerId === 0` のとき常に 1 オクテット形 (L=0) を返す。TID / B を 2 オクテット形の条件から外す
- RFC 9626 §3.1 の L=0 形は `S|E|I|D|B|TID` を 1 オクテットに載せる形であり、LID と TL0PICIDX を省略しても TID は残る。§3.2 の「残り 4 bits は送信時に 0、受信時に無視する」は short extension format の規則であって、long extension の L=0 形を読む受信者には適用されない
- RTP では L ニブルが長さの識別子で §3.1 の L=0 形と §3.2 が同じワイヤになるが、LOC の Video Frame Marking は draft-ietf-moq-loc-04 §2.3.2.2 の length prefix で Value 長が明示される。長さが明示された Value を §3.2 の short extension と解釈する必然性は無く、LID が 0 である以上 L=0 の 1 オクテット形を選ぶのが §3.1 に忠実である
- 相互運用の実測が無いため、判断の根拠 (length prefix で Value 長が明示されること) を本 issue に残す。`CHANGES.md` は `CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール: CHANGES.md を更新しない」に従い更新しない
- decode 側は変更しない。Length 1 の byte1 から B / TID を読む現挙動 (`parseVideoFrameMarkingValue`) がそのまま 1 オクテット形の読み取りになり、`decodeVideoFrameMarkingAfterId` の Length 1〜4 の受理も維持する
- `src/loc.ts` の JSDoc と `encodeVideoFrameMarkingValue` の L の選択条件の本体コメントを新しい条件に合わせる。`LOCPropertyId.VIDEO_FRAME_MARKING` と `VideoFrameMarking` の JSDoc も新しい条件と矛盾しないようにする
- 固定バイト列テストを更新する。`src/loc.test.ts` の LID=0 / TID=1 のケースは 1 オクテット形 (`[0x09, 0x01, 0xe9]`) になる。テスト名の「LID と TID が 0 なら 1 オクテット形、それ以外は 2 オクテット形になる」も新しい条件に合わせる。`src/loc.prop.ts` の Value 長 PBT (検証しているのは `encodeVideoFrameMarking` のワイヤ長) は折り畳み後の LID が 0 なら 3、それ以外は 4 に変え、テスト名「Value 長は LID と TID が 0 のときだけ 1 オクテットになる」とコメント「LID=0 かつ TID=0 のときに限る」も新しい条件に更新する
- `CHANGES.md` の `## develop` には 0648 のエントリが残っていない (8d54b822 で削除済み) ため、書き換え対象は無い。新しいエントリも足さない
- 対象は `src/loc.ts` / `src/loc.test.ts` / `src/loc.prop.ts` とする。`docs/HIGH_LEVEL_API.md` の「LOC コンテナ」節の既定経路の記述は TID=0 固定の話であり変更しない

## 完了条件

- 折り畳み後の `spatialLayerId` が 0 のとき、`temporalLayerId` が 0 以外でも `encodeVideoFrameMarking` のワイヤが 1 オクテット形 (`[0x09, 0x01, byte1]`) になる。byte1 には B と TID が入る
- 折り畳み後の `spatialLayerId` が 0 以外のときは従来どおり 2 オクテット形 (`[0x09, 0x02, byte1, LID]`) になる
- 1 オクテット形 / 2 オクテット形の双方で `temporalLayerId` / `spatialLayerId` の round-trip が成立する。`isBaseLayerSync` は TID=0 で 0 に抑圧される既存規則を除いて round-trip する
- `src/loc.test.ts` の固定バイト列と `src/loc.prop.ts` の Value 長 PBT が新しい長さに更新され、テスト名とコメントも新しい条件に合っている
- `src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の既定経路のワイヤが変わらない (LID=0 / TID=0 のため従来から 1 オクテット)
- `CHANGES.md` は変更していない (`CODEBASE.md` の「MOQT RFC ドラフト中の特別ルール」に従う)
- `vp check` / `vp exec tsc --noEmit` / `vp test run` が通る

## 参照

- RFC 9626 §3.1「L=0 for 1 octet when both the LID and TL0PICIDX are omitted」「LID: ... If no scalability is used, this MUST be 0 or omitted to reduce length. When the LID is omitted, TL0PICIDX MUST also be omitted.」「It is implicitly 0 in the short extension format or when omitted in the long extension format.」。本文は 0694 で `refs/moq/rfc9626.txt` に追加する
- RFC 9626 §3.2 (Short Extension。残り 4 bits は送信時に 0、受信時に無視する)
- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking。`refs/moq/draft-ietf-moq-loc-04.txt`)
- closed `0648-bug-loc-video-frame-marking-bits.md` (LID の 8 bit 化と 1 オクテット形の導入。残した課題に本件がある)
- 0694 (RFC 9626 の `refs/` 追加) / 0696 (loc-04 §2.3.2.2 の length prefix の解釈)

## 解決方法

{未着手}
