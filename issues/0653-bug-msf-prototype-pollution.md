# Catalog の未知フィールド取り込みでプロトタイプが差し替わる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-msf-prototype-pollution
- Polished: {YYYY-MM-DD}

## 目的

Catalog の未知フィールドを保持する処理が `obj[key] = value` の形であるため、JSON に `__proto__` キーがあるとオブジェクトのプロトタイプが差し替わる。受信した JSON をそのまま扱う経路であるため、細工された Catalog でプロトタイプを汚染できる。

## 現状

- `src/msf/catalogValidation.ts` の `validateCatalog` は root の未知フィールドを `KNOWN_CATALOG_ROOT_FIELDS` 以外について `catalogRecord[key] = obj[key]` で保持する
- `src/msf/catalogTrackValidation.ts` の `buildValidatedCatalogTrack` は track の未知フィールドを `KNOWN_TRACK_FIELDS` 以外について `trackRecord[key] = obj[key]` で保持する
- どちらの保持先も通常のオブジェクトリテラルである
- `JSON.parse` は `"__proto__"` を own property として作るため `Object.keys` に現れ、代入が `Object.prototype` の `__proto__` setter を呼ぶ。値がオブジェクトならプロトタイプが差し替わる
- 保持した未知フィールドは `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack` が読み、`resultRecord[key] = ...` の形で書き戻す。保持先だけを変えると、同じ代入がここに残る
- `src/msf.test.ts` の「Catalog: 未知ルートフィールドは検証しないが保持する」が保持と round-trip を確認するが、`__proto__` は確認していない

## 設計方針

- 未知フィールドの保持先を `Object.create(null)` のマップか `Map` に変える。`Map` なら prototype 経由の代入が起きない
- 保持先と書き戻し先を `src/msf/catalogValidation.ts` / `src/msf/catalogTrackValidation.ts` / `src/msf/variables.ts` で揃える。1 箇所だけ直すと汚染経路が残る
- 保持先を変える場合は、未知フィールドを読む `src/msf/variables.ts` と encode 経路の型とアクセス方法を合わせて更新する
- 既知フィールドの扱いと、未知フィールドの round-trip は維持する
- `__proto__` を含む JSON を decode するテストを `src/msf.test.ts` に追加する

## 完了条件

- `__proto__` を含む JSON を decode してもプロトタイプが差し替わらない
- 未知フィールドが従来どおり保持され、round-trip する
- `__proto__` を含む Catalog のテストが追加される
- `npx vp check` / `npx vp test --run` が通る

## 解決方法

{未着手}
