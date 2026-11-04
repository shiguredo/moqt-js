# 対応済み Property の重複を既定で拒否し未知型の反復を保つ

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §8.4 は、定義が反復を許す場合を除いて同じ Track / Object の対応済み Property を 1 つとし、受信違反を malformed track とした。未知 Property の複数出現は許容されるため、全 ID の一律重複禁止にもできない。

## 現状

- `src/properties.ts` の `decodeProperties` は重複した通常 Property を配列に残す。`parseProperties` は抽出対象の Prior Gap / Immutable の重複を拒否するが、その他の型は unknownProperties の配列に残す
- Object 側の `assertObjectPropertyList` は Immutable / Prior Gap の一部の重複だけを検査する
- `src/loc.ts` の `extractLocProperties` は同一 ID の後続値で上書きする。`encodeProperties` にも一般の既知 Property の一意性確認は無い

## 設計方針

- 対応済み型の反復可否を定義し、明示的に許可されない重複を検出する。scope の定義は 0913 と共有できる形にする
- mutable list と Immutable Properties 内側を検索し、個別 Property の定義に従って出現回数を数える。既存の Prior Gap の合算規則を維持する
- Track Properties を許容する文脈と通常 Object の受信時は MalformedTrackError とし、送信 API も既知の不正な重複を生成しない。0913 と同様、空必須 OK の非空 Track Properties は §9.3 の INVALID_FIELD による Session 終了を維持する。汎用 KVP codec で未知 Property まで一律に拒否しない
- 受信 PUBLISH の既知 Property 重複は未知 Mandatory Property の UNSUPPORTED_EXTENSION と原因を区別し、0913 と同じ取消しを行う。未確立 PUBLISH は CANCELLED (0x01) による RESET_STREAM / STOP_SENDING、同じ Track の既存購読 / FETCH は cancelMalformedTrackPeers に接続し、ローカルには MalformedTrackError を通知する。relay publisher 向けの REQUEST_ERROR / reset の MALFORMED_TRACK (0x12) は使わない
- 既知値の上書きで違反を隠さず、LOC の寛容な抽出と transport の受信検証を分ける
- PBT の Property 任意生成が同じ既知型を重複させて正常例を作っていないか更新する

## 完了条件

- Track と Object の既知 Property 重複、mutable と Immutable の組み合わせを検証する
- 未知型・GREASE の反復は重複を理由に拒否せず、既知型の例外は個別定義に従う。非 GREASE の未知 Mandatory Property に対する拒否は 0912 と同様に維持する
- 不正な後続値で先行値を上書きして正常処理しない
- 同一 Track の取消しと、送信前拒否をそれぞれ検証する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §8.4 / §9.3 / §10.7〜§10.9 / §12.1 / §12.3 / §12.5
- `src/properties.ts` の `encodeProperties` / `decodeProperties` / `parseProperties` / `assertObjectPropertyList`
- `src/loc.ts` の `extractLocProperties`、`src/properties.prop.ts`、`src/message/*.prop.ts`
- closed 0122 は Immutable / Prior Gap の個別規則であり、一般の既知 Property 重複規則とは別である

## 解決方法

- `src/properties.ts` に対応済み Property の重複検証を追加した。§8.4 の「定義が反復を許す場合を除いて 1 インスタンス」を既定とし、対応済み型のみを数える。`REPEATABLE_PROPERTY_TYPES` (複数出現を明示的に許す型。現在なし) と `DEDICATED_DUPLICATE_RULE_TYPES` (IMMUTABLE_PROPERTIES / Prior Gap の既存個別規則) を 0913 の scope レジストリと同じ構造で管理する。
- `findDuplicateSupportedProperty` / `assertNoDuplicateSupportedProperties` / `assertNoDuplicateSupportedPropertiesInObjectProperties` を追加した。mutable list と Immutable Properties の内側を合算して数え、mutable 同士・Immutable 内側同士・両方にまたがる重複を検出する (§10.7)。Prior Gap と IMMUTABLE_PROPERTIES は個別規則の文言・合算規則を維持するため汎用検証から除外した。
- `decodeProperties` は scope 指定時 (Track Properties 文脈) に対応済み Property の重複を `MalformedTrackError` とする。Object データストリーム受信時も同じ検証を接続し、セッション終了にはせず既存の malformed track 取消し経路に乗せる。
- scope 未指定の呼び出し (空必須 OK など) は従来どおり検証しないため、§9.3 の INVALID_FIELD による Session 終了の優先を壊さない。汎用 KVP codec で未知 Property まで一律に拒否しない。
- 送信側は `assertNoDuplicatePropertiesForSend` を追加し、唯一の Track Properties 構築 API `buildPublishTrackProperties` が既知の不正重複を送信前に拒否する。`encodeProperties` は不正ワイヤ構築 (テスト・relay 実装) を妨げないよう検証しない。
- `src/loc.ts` の `extractLocProperties` の寛容な後勝ち上書きは変更せず、transport の受信検証層で先に重複を検出する形にした。
- テストは Track / Object の対応済み重複、mutable 同士・Immutable 内側・またがり、未知 Type と GREASE の反復許容、Prior Gap の合算規則と既存文言の維持、Object Property の重複 malformed、送信側の重複拒否を検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限 (未実装)

- 既知 Property の重複した PUBLISH は `MalformedTrackError` になるが、Track を同定して同じ Track の既存購読 / FETCH を `cancelMalformedTrackPeers` で取消しアプリへ通知する経路は未実装である。現状は既存の malformed 経路で受信要求ストリームを cancel するのみ (Session は閉じない)。
- SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK / REQUEST_UPDATE_OK の Track Properties 重複検証は未接続である (§9.3 の INVALID_FIELD 優先のため、応答ハンドラ単位の配置と同 Track 取消し配線が別途必要)。
- 将来、複数インスタンスを許す Property 定義が追加された場合は `REPEATABLE_PROPERTY_TYPES` へ登録する必要がある。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
