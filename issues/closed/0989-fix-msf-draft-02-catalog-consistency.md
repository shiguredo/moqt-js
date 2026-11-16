# catalog 全体の整合検証を draft-02 に合わせる

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

監査で、catalog 全体を見ないと判定できない MUST の検証漏れが見つかった。

## 現状

- §5.2.9 / §5.2.10 は、同じ render group と alternate group の track が同一の target latency / target buffers を持つことを MUST とする。実装は `accessibleWindowTime` の一致だけを検証する
- delta の `remove` は `name` と `namespace` を typeof だけで検証する。空文字列、孤立サロゲート、`a//b` のような不正な namespace を受理する
- full catalog の購読時、namespace 継承後の Full Track Name の一意性を検証しない。delta 適用時は検証するため、経路によって挙動が異なる
- Table 7 の予約 role `data` が `RESERVED_TRACK_ROLES` に無い

## 設計方針

- `src/msf/catalogValidation.ts` に `assertGroupFieldConsistent` を追加し、render group と alternate group の両方について `targetLatency` と `buffers` の一致を検証する。§5.2.9 / §5.2.10 は `isLive` が false の track のフィールドを無視する MUST なので、`isLive` が true の track だけを対象にする
- `validateRemoveTrack` に `assertCatalogTrackName` と `assertCatalogNamespace` を適用する
- `src/createMediaSubscriber.ts` の catalog 受信経路で、decode 直後に catalog namespace を継承した Full Track Name の一意性を検証する。`processCatalogPayload` は既に `catalogNamespace` を受け取っているため、そこで検査する
- `RESERVED_TRACK_ROLES` に `data` を追加する

## 完了条件

- 同じ render group / alternate group で `targetLatency` または `buffers` が違う catalog を拒否する。単体テストで固定する
- `isLive: false` の track は一致検証の対象外になる。単体テストで固定する
- 不正な `remove` の name / namespace を拒否する。単体テストで固定する
- namespace 継承後の Full Track Name が重複する full catalog を購読時に拒否する。単体テストで固定する
- `data` role を予約 role として扱う。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/catalogValidation.ts` に `assertGroupFieldsConsistent` を追加し、同じ render group / alternate group の track が同じ `targetLatency` (§5.2.9) と `buffers` (§5.2.10) を持つことを検証する。両節とも `isLive` が false のときはフィールドを無視する MUST のため、true の track だけを比較する
- `validateRemoveTrack` と `applyCatalogDelta` の remove で、`name` と `namespace` を `assertCatalogTrackName` / `assertCatalogNamespace` で検証するようにした
- `src/createMediaSubscriber.ts` の `processCatalogPayload` で、full catalog も namespace 継承後の Full Track Name の一意性を検証するようにした (delta 適用時と同じ規則)
- `RESERVED_TRACK_ROLES` に Table 7 の `data` を追加した
- PBT の catalog arbitrary が group 内で矛盾する値を生成しないよう、group ごとに最初の track の値へ揃える正規化を追加した
