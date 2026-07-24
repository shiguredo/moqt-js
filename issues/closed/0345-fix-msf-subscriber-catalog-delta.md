# MediaSubscriber が Catalog delta を破棄するのを修正する

- Priority: Medium
- Created: 2026-07-24
- Completed: 2026-07-24
- Model: Composer
- Branch: feature/fix-msf-subscriber-catalog-delta
- Polished: 2026-07-24

## 目的

`#0316` で Catalog の delta ワイヤと `applyCatalogDelta` は追従済みだが、`createMediaSubscriber` が `CatalogDelta` をサイレント破棄している。あわせて Catalog の Joining FETCH が Absolute Start 0 のままであり、MSF §5 の Relative Joining (offset = 0) と一致しない。delta 適用と Joining FETCH Relative 化（FETCH 中バッファ含む）を行う。

## 優先度根拠

Catalog の破壊的変更自体は `#0316` で完了しているため、loc-04 ほど緊急ではない。ただし Joining FETCH 後の Object ID ≥ 1 の delta が捨てられ、カタログ更新が届かない。相互運用を損なうため Medium。

## 現状

正本は `refs/moq/draft-ietf-moq-msf-01.txt`。

### 実装済み (`#0316`)

- Catalog `version` 文字列、`deltaUpdate` operation 配列ワイヤ、`applyCatalogDelta` / `decodeCatalogMessage`

### 本 issue の対象

- `createMediaSubscriber.handleCatalogObject` はフルカタログのみ処理し、`CatalogDelta` をサイレント `return` している
- `devtools/src/hooks/useSubscriber.ts` も同型 skip。本 issue の必須範囲外（任意フォロー）
- decode 後、`Catalog` は必須 `version`、`CatalogDelta` は内部マーカー `deltaUpdate: true`（wire の boolean 形式ではない。draft-00 boolean は decode 時点で reject）。wire 判別は `deltaUpdate` が Array
- Catalog 購読は `joiningFetch: { type: "absolute", start: 0n }`。`#0316` はこれで §5「Joining FETCH (offset = 0)」MUST を満たすと書いたが、transport-19 では Relative Joining Start=0 が `{Largest.Group, 0}`、Absolute Start=0 は `{0, 0}` であり **別物**。映像購読は既に `type: "relative"`
- Catalog 側に映像の `videoFetchInProgress` / `pendingVideoObjects` 相当が無く、FETCH 完了前に live SUBSCRIBE へ delta が届くと `receivedCatalog === null` で捨てられ再送されない

### 本 issue では扱わないもの

- URI fragment reserved key helper → `#0356`
- Prior Group ID Gap 計算 helper → `#0357`
- `docs/MSF.md` 縮小更新 → `#0358`
- MSF_COMPRESSION → `#0355` (pending)
- Log / Metrics track payload → `#0348` / `#0349`
- Authorization Token 自動付与 → `#0350`
- 未知 catalog field の Variable Substitution → `#0351`
- `connection=q|wt` の transport 適用 → `#0352`
- Secure Objects 暗号化実行 → `#0354` (pending)
- publisher 側 Catalog delta 送信 → 対象外
- delta 適用後の audio / video 再購読・decoder 再構成 → 対象外（`onCatalog` まで。呼び出し側責務）
- `applyCatalogDelta` への `catalogNamespace` 引き渡し → 対象外（後述）
- §5「latest Group より前の catalog を Location で無視」のゲート → 対象外（Relative Joining 化で正規経路を満たす。別 Location 比較はしない）

## 設計方針

### 規範引用

- §5: Subscribers MUST use SUBSCRIBE with a Joining FETCH (offset = 0)。latest Group の first Object より前の catalog update は MUST ignore（本 issue では Relative Joining 化で正規経路を満たし、Location 比較ゲートは実装しない）
- §5.3: delta は `deltaUpdate` を最低 1 operation 付きで MUST。`version` / `tracks` MUST NOT。operations は順次適用

### Joining FETCH

- `subscribeCatalog` の `joiningFetch` を `{ type: "relative", start: 0n }` に変更する（MSF offset=0 = Relative Joining Start 0）
- 冒頭 JSDoc の Absolute MUST 誤記も合わせて訂正する
- FETCH フェーズ用フラグ + live バッファ配列を用意する（映像の `videoFetchInProgress` / `pendingVideoObjects` に相当）
- **フラグは `session.subscribe` 呼び出し前に立てる**（映像 `#0177` と同型。subscribe 後だと SUBSCRIBE_OK までの race で live がバッファを迂回する）
- FETCH 経由の object は即時に純関数適用。live はフェーズ中バッファ
- **`onEnd` / `onError` ともバッファを破棄せず順適用（ドレイン）してからフラグを下ろす**。映像経路は `onError` で破棄するが、Catalog は初回待ちのため同型破棄にしない。`largestLocation` 無し時の即時 `onEnd` も同じ
- バッファ配線は純関数テスト対象外。ドレインとフラグ立て位置はコードレビューで確認する

### delta 配線

- 判別は `message.deltaUpdate === true`（`CatalogDelta` 内部マーカー）に統一する
- **フルカタログ未受信時の delta は無視する**（`onError` しない。現行サイレント `return` を維持する実装方針。§5 precede-latest の根拠には使わない）
- `applyCatalogDelta` / decode 失敗時は `onError`、`receivedCatalog` は維持
- 独立カタログは置換。delta 成功時は適用後フルカタログで `onCatalog`
- **`catalogResolve` 契約（ハング防止）**:
  1. FETCH フェーズ中にフルが来ても resolve しない（残 FETCH / ドレイン前の `extractTrackInfo` を防ぐ）
  2. FETCH フェーズ終了（`onEnd` / `onError` ドレイン後）に `receivedCatalog != null` なら resolve
  3. フェーズ終了時点でまだ null（例: largest 無しの即時 `onEnd`）なら、**その後の初回フル適用時に resolve**する
  4. カタログ受信タイムアウトは「未 resolve」で reject する（現行の `!receivedCatalog` だけだと、フル到着後に resolve しない契約と組みで `start()` がハングする）
- `generatedAt` / `isComplete` の merge は `applyCatalogDelta` に委譲し、配線側で再実装しない
- Object ID と payload 種別の不一致は本 issue では見ない（decode 結果のみで判別）

### catalogNamespace

- `MediaSubscriberOptions.namespace` は `string[]`（カタログ track の MOQT Track Namespace）であり、`applyCatalogDelta` の `catalogNamespace?: string`（MSF JSON の Track namespace 継承）とは型も意味も別
- 変換規則が未定義のため本 issue では渡さない。相互運用で §5.2.2 継承が必要なケースは別 issue

### テスト可能な切り出し

- `handleCatalogObject` から、次の純関数を `createMediaSubscriber.ts`（または隣接モジュール）に切り出す:
  - 入力: `current: Catalog | null`, `payload: Uint8Array`
  - 出力: `{ kind: "full" | "delta" | "ignored"; catalog: Catalog | null; error?: Error }`
  - フル → 置換、delta+current → `applyCatalogDelta`、delta+null → ignored、失敗 → error（catalog は current 維持）
- `handleCatalogObject` は切り出し結果を `receivedCatalog` / `onCatalog` / `onError` に配線する（`catalogResolve` は FETCH ドレイン側）
- 単体テストはこの純関数を対象にする（モック禁止。クラス E2E は必須としない）

## 完了条件

### コードベース

- Catalog Joining FETCH が Relative Start 0 であり、FETCH 中の live catalog object を `onEnd` / `onError` ともドレインして欠落させない。バッファフラグは `subscribe` 前に立つ
- `catalogResolve` が FETCH フェーズ終了後に行われ（終了時点で null なら後続の初回フルで resolve）、未 resolve タイムアウトでハングしない
- 純関数経由で delta を `applyCatalogDelta` 適用し、適用後カタログを `onCatalog` に渡す。未受信時 delta は ignored。失敗時は `onError` かつ previous 維持

### テスト / コマンド

- 純関数: フル置換 / delta 適用 / null+delta=ignored / apply 失敗で current 維持、を `*.test.ts` で検証
- `vp run test` / `vp run build` が pass する

### 後方互換・CHANGES

- 後方互換は考慮しない。delta で `onCatalog` が追加発火する
- `CHANGES.md` に `[FIX]`（または挙動変更として `[CHANGE]`。実装時に 1 つ選ぶ）を追記する

## 解決方法

1. `processCatalogPayload` を `createMediaSubscriber.ts` に切り出し、フル置換 / delta 適用 / null+delta=ignored / apply・decode 失敗で current 維持を `createMediaSubscriber.test.ts` で検証した
2. `subscribeCatalog` の Joining FETCH を `{ type: "relative", start: 0n }` に変更し、subscribe 前に `catalogFetchInProgress` を立てて live をバッファ、`onEnd` / `onError` とも `finishCatalogFetchPhase` でドレインする。JSDoc の Absolute 誤記を Relative（§10.12.2.1）に訂正した
3. `catalogResolve` は FETCH フェーズ終了後（またはその後の初回フル）に行い、タイムアウトは未 resolve（`catalogResolve !== null`）で reject する。タイムアウト時はフェーズ状態も解除する
4. `CHANGES.md` の `## develop` に `[FIX]` を追記した

`codec/types.ts` / `src/index.ts` の変更は不要だった。devtools の同型 skip は任意フォローのため未着手。

## 関連

- `#0316` (closed) Catalog 型・ワイヤまでの先行対応（Joining FETCH を Absolute と誤記した点は本 issue で訂正）
- `#0356` URI fragment reserved key helper
- `#0357` Prior Group ID Gap 計算 helper
- `#0358` `docs/MSF.md` 縮小更新
- `#0352` `connection` transport 適用
- `refs/moq/draft-ietf-moq-msf-01.txt`
- `refs/moq/draft-ietf-moq-transport-19.txt` §10.12.2 Joining FETCH
