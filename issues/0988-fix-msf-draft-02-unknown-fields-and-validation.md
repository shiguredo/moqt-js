# 未知フィールドの扱いと入力検証を draft-02 に合わせる

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

監査で、draft-02 の「未知フィールドは無視する MUST」に反する明示拒否と、encode 側の検証漏れが見つかった。

## 現状

- `src/msf/catalogValidation.ts` は小文字の `mimetype` を明示的に拒否する (full catalog と clone)。§5.2.20 の JSON 名は `mimeType` なので `mimetype` は未知フィールドであり、無視 (本実装では保持) されるべきである。しかも update 経路だけは拒否しない
- `src/msf/timeline.ts` の `encodeEventTimeline` は入力の index 個数と data を検証せず、自分の `decodeEventTimeline` が拒否する JSON を出力できる
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` は未知の operation type を黙って無視する
- `src/msf/catalogCodec.ts` の `encodeCatalog` / `encodeCatalogDelta` は `trackBaseKey` をそのまま出力する。§13.2 は、E2E 暗号化されていない catalog に trackBaseKey を含めることを MUST NOT とする

## 設計方針

- `mimetype` の明示拒否を削除し、未知フィールドとして保持する。full / clone / update の全経路で挙動を揃える
- `encodeEventTimeline` に `decodeEventTimeline` と同じ検証 (index が T / L / M のいずれか 1 つ、data が存在、数値が有限) を入れる。encode と decode で受理する集合を一致させる
- `applyCatalogDelta` は未知の operation type で throw する。手組みの delta を渡しても不正な catalog を作らない
- `encodeCatalog` / `encodeCatalogDelta` に `{ e2eEncrypted?: boolean }` を追加し、既定 (false) では `trackBaseKey` を持つ track を拒否する。E2E 暗号化された catalog を扱う場合だけ true を渡す。decode は受け入れたままにする (受信側の MUST ではない)

## 完了条件

- `mimetype` を持つ catalog が full / clone / update のいずれでも受理され、未知フィールドとして保持される。単体テストで固定する
- `encodeEventTimeline` が不正な入力を拒否する。単体テストで固定する
- `applyCatalogDelta` が未知の operation type を拒否する。単体テストで固定する
- `encodeCatalog` / `encodeCatalogDelta` が既定で `trackBaseKey` を拒否し、`e2eEncrypted: true` では出力する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
