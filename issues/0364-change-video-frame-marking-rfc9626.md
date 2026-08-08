# VIDEO_FRAME_MARKING を RFC 9626 §3.1（L=1 形）に準拠させる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-video-frame-marking-rfc9626
- Polished: 2026-08-07

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 が参照する RFC 9626（Video Frame Marking RTP Header Extension）§3.1 の Long Extension 形式（ビット配置とビット値の MUST（B / D ビット））への準拠を 1 目的とし、VIDEO_FRAME_MARKING Property の Value を準拠させる（B / D 是正はその構成要素）。現在は独自レイアウトと B / D ビットの MUST 違反のため、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarking()` は 2 バイトの Value を使用し、byte2 の bits 5-4 に 2-bit の Spatial Layer ID（SID）を置く独自レイアウト。`parseVideoFrameMarkingValue()` は可変長対応（Length=1 は byte2=0 扱い、Length>=2 は先頭 2 バイトから解釈）で、同じ SID 配置を読む。
- RFC 9626 §3.1 の Long Extension の 2 オクテット形（L=1）は「S / E / I / D / B / TID(3bit)」+「LID(8bit)」であり、byte2 は 8-bit LID。LID は「Identifies the spatial and quality layer encoded」であり、空間・品質レイヤー識別を担う（§3.3.1 は VP9 の SID を LID の下位 3 bits に配置すると規定）。コードの SID 配置は位置も意味も RFC 9626 と異なる。受信側は RFC 9626 準拠の送信者の LID 値（例: LID=1 → 0x01）を SID=0 と誤読する。
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk()` と `devtools/src/hooks/usePublisher.ts` はキーフレームに `isBaseLayerSync: true`（B=1）、デルタフレームに `isDiscardable: true`（D=1）を送るが、Temporal Layer ID は常に 0。RFC 9626 §3.1 は B について「When the TID is 0 or if no scalability is used, this MUST be 0」、D について「MUST be 1 for a frame within a layer the sender knows can be discarded and still provide a decodable media stream; otherwise, MUST be 0」と定める。B は TID=0 で B=1 を送るため MUST 違反。D は WebCodecs が破棄可能性の情報を提供しない（`EncodedVideoChunk` に該当フィールドがない）ため、送信者として知らないにもかかわらず D=1 を送る MUST 違反。
- byte1（S/E/I/D/B/TID）のビット位置は RFC 9626 と一致している。SID=0・I=0・D=0・B=0・TID=0 のとき（変更後のデルタフレーム相当）の出力（0xC0 0x00）は L=1 形（LID=0、TL0PICIDX 省略）として byte 一致する（現実のデルタフレームは D=1 のため MUST 違反を含む）。S/E は「1 フレーム = 1 オブジェクト（EncodedVideoChunk 1 つ = フレーム全体）」の前提で常に 1 にしている（前提の明記は設計方針を参照）。
- `src/loc.ts` のコメントは既知の逸脱を明記している（コメント自体が更新対象）。
- I ビットの MUST（「otherwise, MUST be 0」）は既に準拠済み（キーフレーム判定 = `isIndependent`）であり本 issue のスコープ外。

## 設計方針

- RFC 9626 §3.1 の L（長さフィールド）と loc-04 §2.3.2.2 の Length の対応: L=0 = Length=1（1 オクテット、LID / TL0PICIDX 省略）/ L=1 = Length=2（2 オクテット、TL0PICIDX 省略）/ L=2 = Length=3（3 オクテット、TL0PICIDX 付き）。
- RFC 9626 §3.1 の Long Extension の L=1 形（2 オクテット、TL0PICIDX 省略）に合わせ、byte2 を 8-bit LID としてエンコード / デコードする。TL0PICIDX は送信しない（RFC 9626 §3.1「If no scalability is used, or the cyclic counter is unknown, TL0PICIDX MUST be omitted to reduce length.」に整合）。受信時は既存の受理構造（Length 1-4・先頭 2 バイト解釈・余剰消費）を維持したまま、Length=1（L=0 形、LID 暗黙 0。RFC 9626 §3.1「It is implicitly 0 ... when omitted in the long extension format.」）と L=2 形（3 オクテット、TL0PICIDX 付き）も受け付け、先頭 2 バイトのみ解釈し TL0PICIDX は消費のみとする（L=2 形受信時の依存情報は保持しない。本実装は TID=0 のみを送受信対象としており、TL0PICIDX を消費する処理（TID≠0 フレームの依存追跡）が存在しないため不要。保持する場合は別 issue）。Length=4 は RFC 9626 に存在しないが、loc-04 §2.3.2.2 自身が「Length: Varies (1-4 bytes)」と定義しており、既存の受理（1-4）を継続し余剰は消費のみとする。受信側の VFM Value の解釈に関する実装変更は byte2 の解釈（`spatialLayerId: (byte2 >> 4) & 0x03` → `byte2 & 0x03`）と Length=3 の 3 バイト目の意味論（「余剰」→「TL0PICIDX」）の 2 点のみ（0361 実装後は `decodeVideoProperties()` 自体が寛容デコーダに置き換わる点は 0361 のスコープ）。
- `VideoFrameMarking.spatialLayerId`（現状 2-bit、値域 0-3）は RFC 9626 §3.1 の LID（8-bit）の下位 2 bits にマッピングして送信する（上位 6 bits は 0）。受信時は LID の下位 2 bits から spatialLayerId を復元する。コーデック別 LID マッピング規則（§3.3）への完全準拠はスコープ外。VP9 準拠送信者の SID=4-7（LID=4-7）は下位 2 bits で 0-3 に折り畳まれ誤読するが、スコープ外とする（spatialLayerId の値域 0-3 の既存設計を維持）。
- B ビット: `encodeVideoFrameMarking()` は TID=0 のとき `isBaseLayerSync` の値にかかわらず B=0 を出力する（RFC 9626 §3.1 の「When the TID is 0 or if no scalability is used, this MUST be 0」は TID の値に依存するため、エンコーダ側で担保する）。TID≠0 のときは `isBaseLayerSync` の値をそのまま B ビットに反映する（RFC 9626 §3.1 の「When the TID is not 0, this MUST be 1 if the sender knows this frame within a layer only depends on the base temporal layer; otherwise, MUST be 0」の「sender knows」は呼び出し側の知識の主張であり、エンコーダはそれを忠実に反映する）。decode は B を正規化せず忠実に `isBaseLayerSync` へ読み出す（encode 出力として存在しない（TID=0, B=true）の組み合わせは decode 入力として検証する）。
- D ビット: エンコーダは入力（`isDiscardable`）を忠実に反映する（RFC 9626 §3.1 の D は「the sender knows can be discarded」に依存し、呼び出し側の知識の主張であるため）。`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` は破棄可能性の情報を持たないため、`isDiscardable: false` に変更する（現在は `chunk.type !== "key"` で D=1 を送っており MUST 違反）。
- publisher の `isBaseLayerSync: chunk.type === "key"` は変更しない（B はエンコーダの抑圧により TID=0 ではワイヤ上 B=0 になるため、この入力は無効化される。その旨を publisher のコメントで明記する）。
- テストは B 抑圧に伴い Arbitrary の制約（TID=0 のとき `isBaseLayerSync=false` に限定）または出力の正規化（TID=0 のとき B=0 を期待）に更新する（任意入力で恒等というラウンドトリップの不変条件は崩れる）。Arbitrary 制約案では round-trip 恒等が維持され、正規化案では round-trip テストの期待値更新が必要になる。D は入力を忠実に反映するため round-trip は維持される。
- S/E ビットは「1 フレーム = 1 オブジェクト」の前提で常に 1 とし、その前提をコメントに明記する（フレーム分割導入時は別途見直す）。S/E は入力フィールドではなくエンコーダの固定出力のため、decode 入力の固定バイト列検証でのみ検証する。
- ビット配置を固定バイト列で検証するテストを追加し、既存テストの期待値を更新する。frameMarking のテストは `src/loc.prop.ts` に集中している（`src/loc.test.ts` には存在しない）。期待値が変わる既存テスト: `src/loc.prop.ts` の Length=3 / Length=4 の SID 解釈テスト（Length=3: byte2=0x20 → 旧 SID=2 → 新 LID=32 の下位 2 bits=0、Length=4: byte2=0x10 → 旧 SID=1 → 新 LID=16 の下位 2 bits=0）とキーフレームの B=1 テスト。テスト名の「SID」表記（LID 下位 2 bits に置き換わる）も更新する。

## 完了条件

- VIDEO_FRAME_MARKING の Value ビット配置が RFC 9626 §3.1（L=1 形）と一致する。encode の出力と decode の入力の双方向を固定バイト列で検証するテストがあること（TID=0 かつ `isBaseLayerSync: true` の入力で B=0 になることも固定バイト列で検証すること）。
- Length=1（L=0 形、LID 暗黙 0）/ Length=3（L=2 形、TL0PICIDX は消費のみ）/ Length=4（余剰は消費のみ）の decode を固定バイト列で検証するテストがあること。
- TID=0 のオブジェクトに B=1 が送信されない（`src/createMediaPublisher.ts` と `devtools/src/hooks/usePublisher.ts` の両方。B はエンコーダの抑圧で担保され、publisher の `isBaseLayerSync: true` はワイヤ上 B=0 になる旨を publisher のコメントで明記する）。破棄可能性の情報がないため D=1 も送信されない（publisher は `isDiscardable: false` に変更し、その理由（WebCodecs が破棄可能性の情報を提供しないため）を publisher のコメントで明記する）。
- `VideoFrameMarking.spatialLayerId` が LID の下位 2 bits にマッピングされ、固定バイト列（I / D / B / TID / LID の各組み合わせ。S/E は常に 1 で固定のため decode 入力でのみ検証）でラウンドトリップするテストがあること。encode の byte2 が spatialLayerId を下位 2 bits に載せ上位 6 bits が 0 であること（例: spatialLayerId=3 → byte2=0x03）を固定バイト列で検証すること。LID 上位ビット非ゼロの入力（例: LID=0x04 → spatialLayerId=0、LID=0xFF → spatialLayerId=3）を decode して下位 2 bits のみ復元されること（VP9 準拠送信者の折り畳み挙動）を固定バイト列で検証すること。（TID=0, B=true）は decode 入力の固定バイト列として検証する。
- `src/loc.ts` のコメント（既知の逸脱の明記。`LOCPropertyId.VIDEO_FRAME_MARKING` の JSDoc / `VideoFrameMarking` の JSDoc / `encodeVideoFrameMarking()` の JSDoc / `parseVideoFrameMarkingValue()` の JSDoc（SID 表記）の 4 箇所）が、新レイアウトの記述（LID 下位 2 bits マッピング / B 抑圧 / TL0PICIDX 送信しない・受信時は消費のみ / S/E の「1 フレーム = 1 オブジェクト」前提）に更新されていること。
- `src/loc.prop.ts` の既存テストの期待値（Length=3 / Length=4 の SID 解釈、キーフレームの B=1、ラウンドトリップ）とテスト名の「SID」表記が更新されていること。後続 Property 付きの固定バイト列（既存の Length=3 / Length=4 テストの trailing TIMESTAMP 検証等）は 0361 実装後は delta KVP 形式で組み立て直す（単一 Property のみは絶対値とビット一致のため変更不要）。
- `docs/HIGH_LEVEL_API.md` の「VIDEO_FRAME_MARKING: キーフレーム判定、破棄可能フラグ（映像のみ）」が実装と一致していること（D は送信しない旨に更新）。
- `CHANGES.md` の `## develop` に、既存の独自レイアウトで送受信していた moqt-js 相互運用も壊れるワイヤ非互換を含む `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking)
- RFC 9626 §3.1 (Long Extension for Scalable Streams)（L=0/1/2 のオクテット数と B / D / LID / TL0PICIDX の MUST 文言）
- 関連: `0361-change-loc-object-properties-delta-encoding.md`（同じテストを触るため実装順は 0361 が先）
- 関連: `issues/closed/0344-change-loc-follow-draft-04.md`（RFC 9626 フル準拠を範囲外とした経緯。本 issue はその一部を実施する）

## 解決方法

未着手。
