# LOC を draft-ietf-moq-loc-04 に対応させる

- Priority: High
- Created: 2026-07-22
- Completed: 2026-07-22
- Model: qwen3.8-max-preview
- Branch: feature/update-loc-v04
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-loc-04 で Property ID の再割り当てと Audio Config の追加が行われたため、LOC 実装を最新仕様に追従させる。

## 優先度根拠

draft-02 の AUDIO_LEVEL (ID: 6) と TIMESTAMP (ID: 0x06) の ID 衝突は仕様上のバグであり、draft-04 で解消された。ID 衝突は AudioProperties のデコードを正しく行えない致命的な問題であり、早急な対応が必要。

## 現状

- `src/loc.ts` は draft-ietf-moq-loc-02 基準で実装されている
- TIMESTAMP (0x06) と AUDIO_LEVEL (6) の ID が衝突しており、AudioProperties のラウンドトリップテストが書けない状態
- VIDEO_FRAME_MARKING (ID: 4, 偶数) は varint 形式でエンコードされている
- Audio Config のエンコード / デコードが未実装

## 設計方針

draft-ietf-moq-loc-04 Section 6.1 MOQ Properties Registry の IANA テーブルに従い Property ID を更新する。

| プロパティ               | draft-02 ID | draft-04 ID | 形式                            |
| ------------------------ | ----------- | ----------- | ------------------------------- |
| TIMESTAMP                | 0x06        | 0x10        | varint (偶数)                   |
| TIMESCALE                | 0x08        | 0x08        | varint (偶数、変更なし)         |
| VIDEO_FRAME_MARKING      | 4           | 0x09        | length + bytes (奇数に変更)     |
| AUDIO_LEVEL              | 6           | 0x0C        | varint (偶数)                   |
| VIDEO_CONFIG (旧 CONFIG) | 13          | 0x0D        | length + bytes (奇数、変更なし) |
| AUDIO_CONFIG (新規)      | -           | 0x0F        | length + bytes (奇数)           |

VIDEO_FRAME_MARKING は ID が偶数から奇数に変わったため、varint 形式から length + bytes 形式にエンコード方式を変更する。

## 完了条件

- 全 Property ID が draft-ietf-moq-loc-04 の IANA テーブルと一致する
- VIDEO_FRAME_MARKING が length + bytes 形式でエンコード / デコードされる
- Audio Config のエンコード / デコードが実装される
- AudioProperties のラウンドトリップテストがパスする
- devtools / README の仕様参照が draft-04 に更新される
- 全テストがパスする

## 解決方法

- `src/loc.ts` の `LOCPropertyId` を draft-04 の IANA テーブルに合わせて更新した
- `encodeVideoFrameMarking` / `decodeVideoFrameMarking` を length + bytes 形式に変更した
- `encodeConfig` / `decodeConfig` を `encodeVideoConfig` / `decodeVideoConfig` にリネームした
- `encodeAudioConfig` / `decodeAudioConfig` を追加した
- `AudioProperties` に `audioConfig` フィールドを追加した
- `src/loc.prop.ts` に AudioProperties / AudioConfig のテストを追加した
- devtools のコメントと README の仕様参照を draft-04 に更新した
- 関連する pending issue 0036 (AUDIO_LEVEL / TIMESTAMP ID 衝突) を closed にした
