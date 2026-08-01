# Object Properties のエンコードを delta encoding に追従させる

- Created: 2026-08-01
- Completed: 2026-08-01
- Branch: feature/change-object-properties-delta-encoding
- Polished: 2026-08-01

## 目的

draft-ietf-moq-transport-19 §11.2.1.2 / §2.5 に基づき、Object Properties のエンコード / デコードを仕様の Key-Value-Pairs（Figure 2、delta encoding）に追従させる。現在は absolute な Type + Length + Value 形式でエンコードしており、仕様準拠の対向と相互運用できない。

## 現状

- `src/properties.ts` の `mergeDeliveryTimeoutObjectProperties()` / `readDeliveryTimeoutObjectProperties()` は、Object Properties を absolute な Type + Length + Value 形式でエンコード / デコードする。
- 一方 `src/properties.ts` の `encodeProperties()` / `decodeProperties()`（Track Properties 用）は仕様の Key-Value-Pairs（Figure 2）に従い delta encoding を使用する。
- draft-ietf-moq-transport-19 §2.5 は「Properties are serialized as Key-Value-Pairs (see Figure 2)」、§11.2.1.2 は「Object Properties are serialized as a length in bytes followed by Key-Value-Pairs (see Figure 2)」と定め、Track / Object Properties とも Figure 2 の delta encoding を使う（Object Properties のみ外側に length プレフィックスが付く）。
- 現実装は偶数 ID（OBJECT_DELIVERY_TIMEOUT=0x02 / SUBGROUP_DELIVERY_TIMEOUT=0x06）にも Length フィールドを付ける 3 フィールド形式だが、§1.4.3 は偶数 Type の Length を禁止し varint value のみを許す。このため単一の delivery timeout Property でも仕様準拠の受信側は Length バイトを Value と誤読する。複数 Property（delivery timeout 2 種、GREASE Property との併用）では 2 番目以降の Type が delta 復元できず、誤読がさらに拡大する。GREASE 注入機能で複数 Property 化が現実化した。

## 設計方針

- Object Properties のエンコード / デコードを `encodeProperties()` / `decodeProperties()` と同じ delta encoding（Figure 2）に統一する。
- `mergeDeliveryTimeoutObjectProperties()` / `readDeliveryTimeoutObjectProperties()` と、Object Properties への GREASE 注入（`appendGreaseObjectProperty()`）を delta 規約に整合させる。
- delta encoding は Type の昇順（非負 delta）が前提のため、既存バイト列への合成は「デコードして Property[] に分解 → 合成 → ID 昇順ソート → 再エンコード」の再構成方式にする。`encodeProperties()` と同じく ID 昇順でエンコードする。
- 合成側（`mergeDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()`）のデコードにも Track 向け `decodeProperties()` は使わず、合成用の寛容デコーダを使う。合成時のデコード失敗（不完全・不正な既存バイト列）は、既存を破棄して再構成する（`mergeDeliveryTimeoutObjectProperties()` は型付き値のみ、`appendGreaseObjectProperty()` は GREASE Property のみを返す）。現行の「既存が不完全なら全バイトを保持」は delta 連鎖を壊した不正バイト列を送信し得るため継続しない。
- 再構成では未知 Property を id + value / id + data として保持して復元し、型付き値で上書きする ID（0x02 / 0x06）は既存の全出現を除外して 1 つ追加する。
- 受信側の `readDeliveryTimeoutObjectProperties()` も delta encoding に追従させる。Object 経路では Track 向け `decodeProperties()` の厳密検証（Mandatory Track Property 0x4000-0x7FFF 拒否、`validateTrackPropertyValue()`、Length 上限 2^16-1、Delta Type オーバーフロー 2^64-1 の各 MUST のうち、仕様 §1.4.3 が定めるもの）を流用しない。寛容な抽出経路では一切の厳密検証を行わない（その旨をコメントで明記する）。不完全な properties でもオブジェクト配信は継続し、抽出不能な場合は型付きフィールドだけ未設定のまま維持する（delivery timeout Object Property 導入時の完了条件を維持）。delta 形式は Type が前 Property との差分で連鎖するため、途中で壊れた場合は後続 Property の抽出が全滅し、抽出済みの先行値のみが保持される点は許容する（absolute 形式より寛容性が低下する既知の制約）。
- 受信経路の呼び出し元 `processSubgroupObjects()`（`src/session/stream.ts`）は出力形式が不変のため実質変更なし（コメント整合のみ）。
- 後方互換性は考慮しない（プロジェクト方針。旧 absolute 形式との相互互換は保証しない。draft 追従の変更として 0342 / 0359 と同様に扱う）。

## 完了条件

- Object Properties が delta encoding（Figure 2）でエンコード / デコードされる。
- 単一の偶数 ID Property（delivery timeout 単体）のワイヤ形式が仕様準拠であること（[Type][Value] の 2 フィールドで Length が付かないこと）を固定バイト列で検証するテストがあること。
- 複数 Property（delivery timeout 2 種や GREASE Property の併用）を含む Object Properties が仕様準拠でラウンドトリップする。
- 複数 Property（偶数 ID + 奇数 ID の GREASE 併用）のワイヤ形式（2 番目以降の Property の Delta Type が前 ID との差分になること）を固定バイト列で検証するテストがあること。
- 寛容な抽出経路が不正な delta / 不正な Length で PROTOCOL_VIOLATION を送出しないこと。
- 不正・不完全な既存バイト列を合成入力にしたとき、出力に不正バイトが残らず、delta 形式に再構成される（`mergeDeliveryTimeoutObjectProperties()` は型付き値のみ、`appendGreaseObjectProperty()` は GREASE のみ）テストがあること。
- 既存の delivery timeout / GREASE Object Property の挙動（値の抽出・注入）が維持される。
- absolute TLV を前提にした既存テスト（`src/properties.test.ts` と `src/dataStream.datagram.test.ts` の `parseObjectPropertyIds` ヘルパ等）が delta 規約に更新されていること。
- `CHANGES.md` の `## develop` に `[CHANGE]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通る。

## 参照

- draft-ietf-moq-transport-19 §1.4.3 (Key-Value-Pair Structure / Figure 2)
- draft-ietf-moq-transport-19 §11.2.1.2 (Object Properties)
- draft-ietf-moq-transport-19 §2.5 (Properties)
- 関連: `0342-draft-19-delivery-timeout-object-property.md`（Object Properties 導入）、`0359-add-grease-properties.md`（GREASE 注入で複数 Property 化が顕在化）

## 解決方法

Object Properties のエンコード / デコードを delta encoding（Figure 2）に追従させた。

- `src/properties.ts`: 寛容デコーダ `decodeObjectPropertiesTolerant()` を新設し、`mergeDeliveryTimeoutObjectProperties()` / `readDeliveryTimeoutObjectProperties()` / `appendGreaseObjectProperty()` を delta 規約に整合させた。既存バイト列との合成は「デコード → 合成 → ID 昇順ソート → 再エンコード」の再構成方式にし、不完全・不正な既存バイト列は破棄して再構成する
- `src/properties.test.ts` / `src/dataStream.datagram.test.ts`: `parseObjectPropertyIds` を delta 対応にし、固定バイト列検証（単一 / 複数 Property）、寛容抽出の非送出、破棄・再構成のテストを追加した
- `CHANGES.md`: `[CHANGE]` を追記した
