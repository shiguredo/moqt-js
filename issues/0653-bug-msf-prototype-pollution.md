# Catalog の未知フィールド取り込みでプロトタイプが差し替わる

- Created: 2026-09-21
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-msf-prototype-pollution
- Polished: 2026-09-21

## 目的

MSF Catalog の decode、変数置換、delta 適用は、JSON の `__proto__` キーをそのまま `record[key] = value` で扱う箇所があり、細工された Catalog で戻り値オブジェクトの `[[Prototype]]` が差し替わる。`Object.prototype` 全体が汚染されるわけではないが、本来存在しないプロパティが継承経由で見える (`encodeCatalog` は `catalog.generatedAt` / `catalog.isComplete` を読むため、差し替えたプロトタイプにこれらの値があると再 encode の JSON に載る)、null プロトタイプにされた場合は `Object.prototype` のメソッド呼び出しが失敗するといった影響が出る。受信した JSON をそのまま扱う経路 (`src/createMediaSubscriber.ts` の `processCatalogPayload` が decode して適用する) であるため、値は攻撃者が制御できる。

## 現状

- `src/msf/catalogValidation.ts` の `validateCatalog` は root の未知フィールドを `catalogRecord[key] = obj[key]` で保持する。保持先は通常のオブジェクトリテラルである
- `src/msf/catalogTrackValidation.ts` の `buildValidatedCatalogTrack` は track の未知フィールドを同じ形で保持する
- `src/msf/catalogCodec.ts` の `decodeCatalogDelta` は delta の未知フィールドを同じ形で保持する
- `JSON.parse` は `"__proto__"` を own data property として作るため `Object.keys` に現れ、継承した `Object.prototype.__proto__` setter が呼ばれてそのオブジェクトの `[[Prototype]]` が差し替わる。値が `null` なら null プロトタイプになり、オブジェクト以外の値は setter に無視されてフィールドごと消える
- 同じ代入形が `src/msf/catalogCodec.ts` の `encodeCatalog` / `encodeCatalogDelta` (未知フィールドの再出力) と、`src/msf/catalogDelta.ts` の `applyCatalogDelta` (base catalog からの引き継ぎ) にもある
- `src/msf/variables.ts` の `resolveCatalogVariables` / `substituteTrack` の書き戻しは spread で作ったオブジェクトへの代入のため own `__proto__` が先にできて setter を踏まない。ただし `substituteUnknownValue` がネストした未知オブジェクトを組み直す箇所と、`substituteTrack` が `authInfo` を組み直す箇所は新しい空オブジェクトへ動的キーで代入するため、今日でも setter を踏む
- 保持した未知フィールドは `%var%` 置換と再 encode のために残す契約である (draft-ietf-moq-msf-01 §5 の ignore 解釈と §5.4、§5.6.14 の `c4m` の例)
- `src/msf.test.ts` の「Catalog: 未知ルートフィールドは検証しないが保持する (§5)」は decode 後の保持だけを確認し、`__proto__` は扱っていない

## 設計方針

- 未知フィールドを保持する契約は変えない。`__proto__` も own data property として保持し、再 encode で wire に戻す (round-trip を維持する)
- 保持先と公開型は変えない。`Map` は `Catalog` / `CatalogTrack` の公開型と JSON wire の形を変え、未知フィールドをプロパティで読む既存テストの書き換えになる。`Object.create(null)` は返却オブジェクトのプロトタイプが null になり、`{...catalog}` で `Object.prototype` に戻るため不変条件を保てない
- 動的キーで `record[key] = value` する箇所は共通ヘルパー `setOwnField(record, key, value)` に寄せる。キーが `"__proto__"` のときだけ `Object.defineProperty` で own data property (writable / enumerable / configurable をすべて true) を作り、それ以外は通常の代入にする。`JSON.parse` が作る own data property と同じ形になり、以降の代入や spread も setter を踏まない
- ヘルパーは新規モジュール `src/msf/ownFields.ts` に置き、対象は次の全箇所とする
  - `src/msf/catalogValidation.ts` (root の未知フィールドの保持)
  - `src/msf/catalogTrackValidation.ts` (track の未知フィールドの保持)
  - `src/msf/catalogCodec.ts` (`decodeCatalogDelta` の保持、`encodeCatalog` / `encodeCatalogDelta` の再出力)
  - `src/msf/catalogDelta.ts` (`applyCatalogDelta` の引き継ぎ)
  - `src/msf/variables.ts` (`resolveCatalogVariables` / `substituteTrack` の書き戻し、`authInfo` の組み直し、`substituteUnknownValue` のネスト組み直し)
- `constructor` などの他のキーは通常の代入でも own property になるため対象外とする
- 完了条件の検証は `Object.getPrototypeOf(decoded) === Object.prototype` で行う。`Object.prototype` が汚染されないことの確認は現行コードでも通るため退行検出に使わない
- `CHANGES.md` の `## develop` に `[FIX]` を追記する

## 完了条件

- `__proto__` を含む Catalog / Catalog Delta / ネストした未知オブジェクトを decode しても、返るオブジェクトとその入れ子の `Object.getPrototypeOf` が `Object.prototype` のままである
- `__proto__` が own property として保持され、`encodeCatalog` / `encodeCatalogDelta` の出力に現れ、再 decode でも保持される (round-trip)
- `%var%` 置換後も `__proto__` を含む未知フィールドが保持され、置換結果のプロトタイプが差し替わらない
- `applyCatalogDelta` で base catalog から引き継いだ `__proto__` が結果のプロトタイプを差し替えない
- 既知フィールドの扱いと既存の round-trip が変わらない
- `src/msf.test.ts` に full catalog / delta decode / `applyCatalogDelta` / 変数置換のテストが追加される。テストの入力は `JSON.parse` (または `Object.defineProperty`) で own `__proto__` を作る。オブジェクトリテラルの `"__proto__"` は own property にならず wire にも載らないため、リテラルで書くと検証にならない
- `CHANGES.md` の `## develop` に `[FIX]` が入る
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5 (A parser MUST ignore fields it does not understand)
- draft-ietf-moq-msf-01 §5.4 (Variable Substitution)、§5.6.14 (未知フィールド `c4m` に `%token%` を適用する例)

## 解決方法

{未着手}
