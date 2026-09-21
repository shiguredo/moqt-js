# MSF Catalog の必須検証が仕様に対して不足している

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-catalog-required-validation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-msf-01 の MUST のうち、Catalog の parser が検証していないものが 3 点ある。仕様違反の Catalog を受理すると、購読側は存在しない初期化データや復号できない設定をそのまま使うことになる。3 点を検証に追加する。

## 現状

- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` は `tracks` と `publishTracks` に対して別々に呼ばれ、配列をまたぐ `(name, namespace)` の重複を検出しない
- `src/msf.test.ts` の「Catalog: tracks と publishTracks の合算 uniqueness は行わない (subscribe/publish 同名共存許容)」が現状の挙動を固定しており、namespace 未指定どうしの同名 track を許容している
- `src/msf/catalogTrackValidation.ts` の `buildValidatedCatalogTrack` は `role` を型検証するだけで、`role` が `video` / `audio` のときの `codec` / `bitrate` / `samplerate` / `channelConfig` の Conditional MUST を検証しない
- `src/msf/tracks.ts` の `resolveInitData` は `initRef` の参照先が `initDataList` に無い場合に undefined を返すだけで、Catalog として拒否しない
- `src/msf.prop.ts` の `catalogTrackArb` は `role` / `codec` / `bitrate` / `samplerate` / `channelConfig` を独立に生成し、`catalogArb` は `tracks` と `publishTracks` に別々の `uniqueCatalogTrackArrayArb` を使うため、いずれも新しい検証を通らない組み合わせを生成する

## 設計方針

- §5.2.3 の「Within the catalog」は `tracks` と `publishTracks` の両方を含むため、2 配列を連結して 1 回の uniqueness 検証にまとめる。`assertTrackNameUnique` の `arrayName` 引数はエラー文言でどちらの配列かが分かる形に見直す
- `role` が `video` のときは `codec` (§5.2.18) と `bitrate` (§5.2.22) を、`role` が `audio` のときは加えて `samplerate` (§5.2.28) と `channelConfig` (§5.2.29) を必須にする。`role` は optional で custom role も許されるため、`video` / `audio` 以外には課さない
- `resolveInitData` は `initRef` の参照先が無い場合に throw する。購読時の description 解決を呼ぶ経路の扱いも合わせて確認する
- `src/msf.prop.ts` の Arbitrary は、`packaging` に応じて `role` を固定している既存の正規化と同じ形で、`role` と必須フィールドの組み合わせを揃える。配列をまたぐ uniqueness も生成後に保証する

## 完了条件

- `tracks` と `publishTracks` をまたぐ `(name, namespace)` の重複が拒否される
- `role` が `video` / `audio` で必須フィールドが欠けた Catalog が拒否される
- `initRef` の参照先が `initDataList` に無い Catalog が拒否される
- 3 点が `src/msf.test.ts` と `src/msf.prop.ts` で固定され、`npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.3 「Within the catalog, track names MUST be unique per namespace.」
- draft-ietf-moq-msf-01 §5.2.18 「This property MUST be specified for tracks which have an inherent codec associated with them (e.g., audio and video tracks).」
- draft-ietf-moq-msf-01 §5.2.22 「This property MUST be specified for audio and video tracks.」
- draft-ietf-moq-msf-01 §5.2.28 / §5.2.29 「This property MUST accompany tracks for which audio codecs are specified.」
- draft-ietf-moq-msf-01 §5.1.7 (initDataList) / §5.2.13 (initRef) / §5.2.6 (role)

## 解決方法

{未着手}
