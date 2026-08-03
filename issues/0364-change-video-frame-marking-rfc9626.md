# VIDEO_FRAME_MARKING を RFC 9626 に準拠させる

- Created: 2026-08-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-video-frame-marking-rfc9626
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 §2.3.2.2 が参照する RFC 9626（Video Frame Marking RTP Header Extension）のビット配置に、VIDEO_FRAME_MARKING Property の Value を準拠させる。現在は独自レイアウトのため、仕様準拠の対向実装と相互運用できない。

## 現状

- `src/loc.ts` の `encodeVideoFrameMarking()` / `parseVideoFrameMarkingValue()` は 2 バイトの Value を使用し、byte2 の bits 5-4 に 2-bit の Spatial Layer ID（SID）を置く独自レイアウト。
- RFC 9626 §3.1 の 2 オクテット形は「S / E / I / D / B / TID(3bit)」+「LID(8bit)」であり、byte2 は 8-bit LID。コードの SID 配置は位置も意味も RFC 9626 と異なる。受信側は RFC 9626 準拠の送信者の LID 値（例: LID=1 → 0x01）を SID=0 と誤読する。
- `src/createMediaPublisher.ts` の `handleVideoEncodedChunk()` はキーフレームに `isBaseLayerSync: true`（B=1）を送るが、Temporal Layer ID は常に 0。RFC 9626 §3.1 は「When the TID is 0 or if no scalability is used, this MUST be 0」と定めており、MUST 違反。
- byte1（S/E/I/D/B/TID）は RFC 9626 と一致しており、SID=0 固定の現実出力は 2 オクテット形（L=1, LID=0, TL0PICIDX 省略）として偶然 byte 一致する。問題は SID>0 の送信と LID の受信解釈で顕在化する。
- `src/loc.ts` のコメントは「Value のビット配置は独自レイアウトを維持する（I / D / B / TID / 2bit SID）。RFC9626 の 8-bit LID / TL0PICIDX までは未対応」と既知の逸脱を明記している。

## 設計方針

- RFC 9626 §3.1 の 2 オクテット形（L=1、LID のみで TL0PICIDX は省略）に合わせ、byte2 を 8-bit LID としてエンコード / デコードする。
- Spatial Layer ID の扱いを整理する。RFC 9626 に空間レイヤー識別は存在しないため、`VideoFrameMarking.spatialLayerId` の送信を廃止するか、アプリ層のメタデータとして扱うかを決定して実装する。
- `createMediaPublisher.ts` の B ビット送信条件を RFC 9626 の MUST（TID=0 またはスケーラビリティ不使用時は 0）に合わせる。
- ビット配置を固定バイト列で検証するテストを追加し、既存テストの期待値を更新する。

## 完了条件

- VIDEO_FRAME_MARKING の Value ビット配置が RFC 9626 §3.1 と一致する。
- TID=0 のオブジェクトに B=1 が送信されない。
- RFC 9626 準拠の固定バイト列（I / D / B / TID / LID の各組み合わせ）でラウンドトリップするテストがあること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-loc-04 §2.3.2.2 (Video Frame Marking)
- RFC 9626 §3.1 (Video Frame Marking RTP Header Extension)

## 解決方法

未着手。
