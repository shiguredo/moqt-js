# MSF draft-01 の追従漏れを解消する

- Priority: Medium
- Created: 2026-07-24
- Completed: YYYY-MM-DD
- Model: Composer
- Branch: feature/change-msf-draft-01-remaining
- Polished: YYYY-MM-DD

## 目的

`#0316` で Catalog 型・検証・delta ワイヤ・URI fragment 解析などは draft-ietf-moq-msf-01 に追従済みである。本 issue では、高レベル API の delta 受信・fragment helper・Prior Group ID Gap・ドキュメント更新など、すぐ着手できる残項目をまとめて解消する。圧縮・暗号化・Log/Metrics 等は別 issue に分離済み。

## 優先度根拠

Catalog の破壊的変更自体は `#0316` で完了しているため、loc-04 ほど緊急ではない。ただし `createMediaSubscriber` が delta update を捨てていること、`docs/MSF.md` が draft-00 時代のままであることは、相互運用とドキュメント信頼性を損なう。直接のワイヤ破綻よりは影響が限定的なため Medium。

## 現状

正本は `refs/moq/draft-ietf-moq-msf-01.txt`。`#0316` (closed) の「範囲外」と現状コードの突き合わせ結果:

### 実装済み (`#0316`)

- Catalog `version` 文字列 (`draft-01` / `1`)、`deltaUpdate` operation 配列ワイヤ、`initDataList` / `initRef`、新規 Track field、Variable Substitution、`parseMsfFragmentValue`、`MsfCompressionAlgorithm` 定数

### 追従漏れ

1. **Subscriber の delta update 適用 (§5.1.6 / §5.3)**
   - `applyCatalogDelta` (`msf.ts:1676`) と decode は実装済み
   - `createMediaSubscriber.ts:608-611` はフルカタログのみ処理し、`version` 無し (delta) を無視する

2. **URI fragment reserved keys (§11.1.1) の helper**
   - `getConnectionParameter` (`msf.ts:2352`) のみ
   - `wallclock-range` / `mediatime-range` / `location-range` / `c4m` の専用 helper が未実装

3. **Prior Group ID Gap シグナリング (§6.1 SHOULD)**
   - `createInitialGroupId` (`msf.ts:2469`) は `Date.now()` ベース
   - restart 時に既知の previous Group ID がある場合の Prior Group ID Gap Object Property 付与は未配線 (MOQT 側の encode 自体は `properties.ts` に存在)

4. **ドキュメント陳腐化**
   - `docs/MSF.md` が draft-00 / transport-15 前提 (`refs/moq/draft-ietf-moq-msf.md` 参照、gzip MAY 記述など)
   - README の MSF 実装状況は Catalog 中心で、未実装項目の過大表記がある

### 本 issue では扱わないもの (別 issue 化済み)

- MSF_COMPRESSION → `#0355` (pending: Property ID TBD)
- Log / Metrics track payload → `#0348` / `#0349`
- Authorization Token 自動付与 → `#0350`
- 未知 catalog field の Variable Substitution → `#0351`
- `connection=q|wt` の transport 適用 → `#0352`
- Secure Objects 暗号化実行 → `#0354` (pending: refs 未取得)

## 設計方針

1. **Subscriber delta 適用**
   - `handleCatalogObject` で `decodeCatalogMessage` の結果が `CatalogDelta` なら、保持中のフルカタログへ `applyCatalogDelta` を適用する
   - フルカタログ未受信時の delta は無視またはエラー方針を仕様・既存挙動に合わせて決める (初回 MUST は independent catalog)
   - `onCatalog` は適用後のフルカタログを渡す

2. **URI fragment reserved keys (helper のみ)**
   - `wallclock-range` / `mediatime-range` / `location-range` / `c4m` の取得 helper を `msf.ts` に追加する
   - `connection` の transport 適用は `#0352` に委譲する

3. **Prior Group ID Gap**
   - 高レベル publisher が restart 後に previous Group ID を知っている場合、最初の Object に Prior Group ID Gap を付与できる経路を用意する
   - SHOULD のため必須化はしない。API / helper とテストで到達可能にすればよい

4. **ドキュメント**
   - `docs/MSF.md` を draft-01 前提に書き直す (または現状実装へのポインタに縮小し、陳腐化した draft-00 記述を削除する)
   - README の MSF 実装状況を、別 issue の未実装項目と矛盾しない形に更新する

## 完了条件

### コードベース

- `createMediaSubscriber` が delta update を `applyCatalogDelta` で適用し、適用後カタログを `onCatalog` に渡す
- URI fragment の reserved key helper (`wallclock-range` / `mediatime-range` / `location-range` / `c4m`) が export され、単体テストがある
- Prior Group ID Gap を付与できる publisher 側経路 (または明確な helper) がある
- `docs/MSF.md` から draft-00 / 存在しない `refs/moq/draft-ietf-moq-msf.md` 前提の記述が消えている
- README の MSF 実装状況が実態と矛盾しない

### テスト / コマンド

- delta 適用・fragment helper のテストが追加されている
- `vp run test` / `vp run build` が pass する
