# VIDEO_FRAME_MARKING を RFC 9626 に準拠させる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-video-frame-marking-rfc9626
- Polished: 2026-08-03

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 が参照する RFC 9626（Video Frame Marking RTP Header Extension）のビット配置とビット値の MUST（B / D ビット）に、VIDEO_FRAME_MARKING Property の Value を準拠させる。現在は独自レイアウトと B / D ビットの MUST 違反のため、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarking()` は 2 バイトの Value を使用し、byte2 の bits 5-4 に 2-bit の Spatial Layer ID（SID）を置く独自レイアウト。`parseVideoFrameMarkingValue()` は可変長対応（Length=1 は byte2=0 扱い、Length>=2 は先頭 2 バイトから解釈）で、同じ SID 配置を読む。
- RFC 9626 §3.1 の Long Extension の 2 オクテット形（L=1）は「S / E / I / D / B / TID(3bit)」+「LID(8bit)」であり、byte2 は 8-bit LID。LID は「Identifies the spatial and quality layer encoded」であり、空間・品質レイヤー識別を担う（§3.3.1 は VP9 の SID を LID の下位 3 bits に配置すると規定）。コードの SID 配置は位置も意味も RFC 9626 と異なる。受信側は RFC 9626 準拠の送信者の LID 値（例: LID=1 → 0x01）を SID=0 と誤読する。
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk()` と `devtools/src/hooks/usePublisher.ts` はキーフレームに `isBaseLayerSync: true`（B=1）、デルタフレームに `isDiscardable: true`（D=1）を送るが、Temporal Layer ID は常に 0。RFC 9626 §3.1 は B について「When the TID is 0 or if no scalability is used, this MUST be 0」、D について「MUST be 1 for a frame within a layer the sender knows can be discarded and still provide a decodable media stream; otherwise, MUST be 0」と定めており、WebCodecs は破棄可能性の情報を提供しないため B / D とも MUST 違反。
- byte1（S/E/I/D/B/TID）のビット位置は RFC 9626 と一致しており、B=0 のときの現実出力は L=1 形（LID=0、TL0PICIDX 省略）として偶然 byte 一致する。S/E は「1 フレーム = 1 オブジェクト（EncodedVideoChunk 1 つ = フレーム全体）」の前提で常に 1 にしている。
- `src/loc.ts` のコメントは「Value のビット配置は独自レイアウトを維持する (I / D / B / TID / 2bit SID)。RFC9626 の 8-bit LID / TL0PICIDX までは未対応」と既知の逸脱を明記している（コメント自体が更新対象）。

## 設計方針

- RFC 9626 §3.1 の Long Extension の L=1 形（2 オクテット、TL0PICIDX 省略）に合わせ、byte2 を 8-bit LID としてエンコード / デコードする。TL0PICIDX は送信しない。受信時は Length=1（L=0 形、LID 暗黙 0）と L=2 形（3 オクテット、TL0PICIDX 付き）も受け付け、先頭 2 バイトのみ解釈し TL0PICIDX は消費のみとする（保持しない）。Length=4 は RFC 9626 に存在しないが、loc-04 §2.3.2.2 自身が「Length: Varies (1-4 bytes)」と定義しており、既存の受理（1-4）を継続し余剰は消費のみとする。
- `VideoFrameMarking.spatialLayerId`（現状 2-bit）は RFC 9626 §3.1 の LID（8-bit）の下位 2 bits にマッピングして送信する（上位 6 bits は 0）。受信時は LID の下位 2 bits から spatialLayerId を復元する。コーデック別 LID マッピング規則（§3.3）への完全準拠はスコープ外。
- B ビット: `encodeVideoFrameMarking()` は TID=0 のとき `isBaseLayerSync` の値にかかわらず B=0 を出力する（RFC 9626 §3.1 の「When the TID is 0 or if no scalability is used, this MUST be 0」は TID の値に依存するため、エンコーダ側で担保する）。
- D ビット: エンコーダは入力（`isDiscardable`）を忠実に反映する（RFC 9626 §3.1 の D は「the sender knows can be discarded」に依存し、呼び出し側の知識の主張であるため）。`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` は破棄可能性の情報を持たないため、`isDiscardable: false` に変更する（現在は `chunk.type !== "key"` で D=1 を送っており MUST 違反）。
- テストは B 抑圧に伴い Arbitrary の制約（TID=0 のとき `isBaseLayerSync=false` に限定）または出力の正規化（TID=0 のとき B=0 を期待）に更新する（任意入力で恒等というラウンドトリップの不変条件は崩れる）。D は入力を忠実に反映するため round-trip は維持される。
- S/E ビットは「1 フレーム = 1 オブジェクト」の前提で常に 1 とし、その前提をコメントに明記する（フレーム分割導入時は別途見直す）。
- ビット配置を固定バイト列で検証するテストを追加し、既存テストの期待値を更新する。frameMarking のテストは `src/loc.prop.ts` に集中している（`src/loc.test.ts` には存在しない）。

## 完了条件

- VIDEO_FRAME_MARKING の Value ビット配置が RFC 9626 §3.1（L=1 形）と一致する。encode の出力と decode の入力の双方向を固定バイト列で検証するテストがあること（TID=0 かつ `isBaseLayerSync: true` の入力で B=0 になることも固定バイト列で検証すること）。
- TID=0 のオブジェクトに B=1 が送信されない（`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の両方）。破棄可能性の情報がないため D=1 も送信されない（publisher は `isDiscardable: false` に変更）。
- `VideoFrameMarking.spatialLayerId` が LID の下位 2 bits にマッピングされ、固定バイト列（S / E / I / D / B / TID / LID の各組み合わせ）でラウンドトリップするテストがあること。（TID=0, B=true）の組み合わせは encode 出力として存在し得ないため、decode 入力の固定バイト列として検証する。
- `src/loc.ts` のコメント（既知の逸脱の明記。`LOCPropertyId.VIDEO_FRAME_MARKING` の JSDoc / `VideoFrameMarking` の JSDoc / `encodeVideoFrameMarking()` の JSDoc / `parseVideoFrameMarkingValue()` の JSDoc（SID 表記）の 4 箇所）が更新されていること。
- `CHANGES.md` の `## develop` に、既存の独自レイアウトで送受信していた moqt-js 相互運用も壊れるワイヤ非互換を含む `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking)
- RFC 9626 §3.1 (Long Extension for Scalable Streams)
- 関連: `0361-change-loc-object-properties-delta-encoding.md`（同じテストを触るため実装順は 0361 が先）
- 関連: `issues/closed/0344-change-loc-follow-draft-04.md`（RFC 9626 フル準拠を範囲外とした経緯。本 issue はその一部を実施する）

## 解決方法

未着手。
