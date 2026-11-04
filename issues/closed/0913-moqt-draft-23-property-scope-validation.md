# 対応済み Property の Track / Object scope 違反を malformed とする

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §8.4 / §12.1 は、対応済み Property を定義外の scope で受信した場合に Track を malformed とする。現在の検証は Mandatory Track Property の Object 出現などに限られ、通常の既知 Property の scope を網羅しない。

## 現状

- `src/properties.ts` の `assertNoMandatoryTrackPropertyInObjectProperties` は Mandatory / Immutable / Prior Gap を検査するが、一般の Track-only Property を照合しない
- `decodeProperties` は呼び出し元の Track / Object scope を受け取らない
- `src/loc.ts` の `extractLocProperties` は scope に応じて抽出するため、Object-only の LOC Property が Track 側に来ても単に抽出されない場合がある

## 設計方針

- 対応済み Property の scope を、transport の定義と LOC の最新登録に基づいて明示する。Object Delivery Timeout など両 scope を持つものを誤って Track-only にしない
- Track Properties を許容する各受信口と、Datagram / Subgroup / FETCH の Object Properties で、解釈前に scope を検証する。PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK のように §9.3 が Track Properties を空必須とする文脈では、非空による INVALID_FIELD の Session 終了を維持し、scope 違反を理由に Track 取消しへ置き換えない。0902 の長さ / delta エラーの優先規則も維持する
- Immutable Properties 内側も周囲の scope として検証する
- 未知 Property は「scope を知らない」ため、この規則だけで拒否しない。既知 Property の Value 形式不正による Session エラーとは区別する
- 違反は MalformedTrackError と既存の同一 Track 取消しへ接続する。寛容な LOC 抽出 helper だけを厳格化して受信経路の検証を代用しない
- 受信 PUBLISH の現在の catch は MalformedTrackError を一律 UNSUPPORTED_EXTENSION にする。既知 Property の scope 違反と未知 Mandatory Property を構造化した原因で区別し、未知 Mandatory は 0903 の UNSUPPORTED_EXTENSION / UNSUPPORTED_PROPERTY で拒否する。scope 違反にはその Detail を使わない
- scope 違反を含む未確立 PUBLISH 自体は §6.4.2.3 の要求取消しとして、送信方向の RESET_STREAM と受信方向の STOP_SENDING を CANCELLED (0x01) で行い、同じ Track の既存購読 / FETCH は cancelMalformedTrackPeers で取消す。ローカルには MalformedTrackError を通知する。REQUEST_ERROR / reset の MALFORMED_TRACK (0x12) は §12.3 / §12.5 の relay publisher 向け定義なので、この subscriber の取消しには使わない
- PUBLISH のヘッダー・Parameters の解析と Property の意味検証を分け、scope 違反でも Request ID と Full Track Name を取得・検証して同じ Track を特定できるようにする。Request ID 検証と認証トークン処理をこの順で非 Session エラーによる取消しより前に行い、例外の理由文字列から Track や原因を復元しない

## 完了条件

- MAX_CACHE_DURATION / DEFAULT_PUBLISHER_PRIORITY / DYNAMIC_GROUPS などの Track-only と、LOC TIMESTAMP / Prior Gap などの Object-only をそれぞれ逆 scope で検証する
- 両 scope の Property、未知 Property、Immutable Properties 内側を検証する
- Track Properties を許容する文脈の scope 違反では、問題の未確立 PUBLISH と同じ Track の購読 / FETCH だけを取消し、無関係な Track や Session 全体を終了しない。空必須 OK の非空 Properties は INVALID_FIELD の Session 終了となる
- 0916 の CODEC_STRING を対応済みに追加したときも同じ定義を使える

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §8.4 / §10 / §12.1 / §16.8
- `refs/moq/draft-ietf-moq-loc-05.txt` §2.3 / §6.1
- `src/properties.ts`、`src/loc.ts`、`src/dataStream/datagram.ts`、`src/dataStream/subgroup.ts`、`src/dataStream/fetch.ts`
- `src/session/incomingPublish.ts`、`src/session/errors.ts` の `toTrackPropertiesViolationSessionError`、draft-ietf-moq-transport-23 §6.4.2.3 / §9.3 / §12.3 / §12.5

## 解決方法

- `src/properties.ts` に Property scope のレジストリを追加した。transport の Table 15 と LOC の最新登録に基づき、対応済み Property ごとに Track scope / Object scope / 両 scope を明示した。OBJECT_DELIVERY_TIMEOUT / SUBGROUP_DELIVERY_TIMEOUT / TIMESCALE / VIDEO_CONFIG / AUDIO_CONFIG / CODEC_STRING など両 scope を持つ Property を誤って Track-only にしていない。
- `getPropertyScope` / `isPropertyScopeAllowed` / `assertPropertyScopes` / `assertPropertyScopesInObjectProperties` を追加し、対応済み Property を定義外の scope で受信した場合は `MalformedTrackError` とする (§8.4 / §12.1)。セッション終了にはせず、既存の malformed track 取消し経路 (datagram / subgroup / fetch の catch) に接続する。
- `decodeProperties` が任意の scope 引数を受け取れるようにし、既存呼び出し元は非互換なく動作する。Immutable Properties の内側は周囲の scope を継承して再帰検証する。未知 Type は scope を知らないため、この規則だけでは拒否しない。
- `src/message/publish.ts` の PUBLISH Track Properties を Track scope で検証し、`src/dataStream/datagram.ts` / `subgroup.ts` / `fetch.ts` の Object Properties は既存の構造・値検証の後に scope 検証を追加した (0902 の長さ / delta エラー優先は維持)。
- `src/loc.ts` の `extractLocProperties` の寛容な抽出契約は変更せず、データストリームの Property 検証層で scope 違反を検出する形にした。
- テストは scope レジストリ、Track-only Property の Object 出現、Object-only Property の Track 出現、両 scope Property の受理、未知 Type の受理、Immutable 内側の scope 継承、PUBLISH の LOC TIMESTAMP (Object-only) 違反、Object Properties の MAX_CACHE_DURATION (Track-only) 違反を検証する。
- docs は 0925 で一括更新するため触っていない。

### 既知の制限 (未実装)

- scope 違反の PUBLISH は `decodePublishPayload` の段階で `MalformedTrackError` になり、`incomingPublishDecodeOrReject` が `incomingPublishPeekTrackKey` で Track を復元して `cancelMalformedTrackPeers` を呼ぶ (実装済み)。受信要求ストリームも cancel し、Session は閉じない。
- SUBSCRIBE_OK / FETCH_OK / TRACK_STATUS_OK の Track Properties scope 検証は実装済み (`decodeProperties(..., "track")` と応答ハンドラの malformed cancel 配線)。空必須の PUBLISH_OK / REQUEST_UPDATE_OK は §9.3 の INVALID_FIELD 優先を維持するため scope を渡さない。
- `CODEC_STRING` (0x11) は scope だけ登録済みで、値の意味論が未対応のため対応済み集合には含めていない。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。
