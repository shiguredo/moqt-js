# GOAWAY メッセージから Request ID フィールドを削除する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-goaway-remove-request-id
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.4 (GOAWAY) のワイヤフォーマットから Request ID フィールドが削除された。変更履歴は Appendix A.1 `#1623` ("Remove Request ID from GOAWAY")。

draft-19 Section 10.4 (Figure 7) のワイヤフォーマット:

```
GOAWAY Message {
  Type (vi64) = 0x10,
  Length (16),
  New Session URI Length (vi64),
  New Session URI (..),
  Timeout (vi64),
}
```

制御ストリームとリクエストストリームでワイヤは同一になり、Request ID の有無による区別は消えた（Table 5 で GOAWAY は Control, Request の両ストリーム、Figure 7 に条件付きフィールド無し）。Section 10.1 は Request ID を持つのは request messages のみとし、GOAWAY はその一覧に含まれない。

draft-18 Section 10.4 にあった末尾の `[Request ID (vi64)]`（制御ストリーム上のみ出現）と、**GOAWAY 文脈の**パリティ不一致時 `INVALID_REQUEST_ID` MUST は draft-19 では存在しない。Section 3.5 / 10.1 の `INVALID_REQUEST_ID` 自体は他リクエスト用に残る。

本変更は closed の draft-18 判断を draft-19 で意図的に撤回するものである。

- `#0188` Request ID 追加
- `#0257` 制御ストリームで Request ID 必須検証
- `#0258` / `#0282` リクエストストリームで Request ID 禁止検証 (`validateGoawayOnRequestStream`)
- `#0273` / `#0286` / `#0288` パリティ検証・関連コメント
- `#0289` のうち `isValidGoawayRequestIdParity` 抽出部分（同 issue の `validateNoDuplicateGoawayOnRequestStream` は残す）

Request ID 非依存の処理（`#0259` 重複 GOAWAY 検出等）は本 issue の対象外であり残す。Section 10.4 の URI 長 / zero-length URI / Timeout 意味・Appendix A.1 `#1787`（session vs per-request migration）も対象外。

moqt-js は draft-18 準拠で Request ID を送受信しているため、draft-19 準拠ピアとの GOAWAY 交換で相互運用が壊れる。

## 優先度根拠

ワイヤフォーマットの破壊的変更であり実害が明確なため High。

- 受信: draft-19 準拠ピアは Request ID なしの GOAWAY を送る。moqt-js は制御ストリーム上の GOAWAY に Request ID が無いとして PROTOCOL_VIOLATION でセッションを切断する (`handleGoaway`)
- 送信: moqt-js は常に `requestId: 1n` を付けて送る。draft-19 準拠ピアは Message Body 定義外の余剰として PROTOCOL_VIOLATION で拒否する

draft-18 ピアとの相互運用は意図的に切る（draft-19 専用への切り替え）。

## 現状

シンボル名を正とし、行番号は目安とする。

- `src/message/session.ts`: `Goaway` 型が `requestId: bigint | null` を保持。`encodeGoawayPayload` / `decodeGoawayPayload` が Request ID を送受信。Timeout 後の残バイトは Request ID として読むが、`decodeVarint` の consumed を offset に反映せず、Request ID より後ろの余剰も検査しない。`isValidGoawayRequestIdParity` が存続
- `src/message/index.ts`: `isValidGoawayRequestIdParity` / `Goaway` / encode / decode を barrel から再エクスポート。`src/index.ts`（パッケージ公開エントリ）はこれらを再エクスポートしていない
- `src/session.ts` `goaway()`: 常に `requestId: 1n` を付与して送信
- `src/session.ts` `handleGoaway`: Request ID 欠落を PROTOCOL_VIOLATION、パリティ不一致を INVALID_REQUEST_ID として閉じる。`receivedGoaway = true` を `decodeGoawayPayload` より前に立てる。制御ストリームループ (`startControlMessageLoop`) は `ProtocolViolationError` を `toProtocolViolationSessionError` → `closeWithError` に変換しない（namespace / request stream ループとは異なる）
- `src/session/bidi.ts` `validateGoawayOnRequestStream`: リクエストストリーム上の GOAWAY に Request ID があれば PROTOCOL_VIOLATION。呼び出しは合計 7 箇所
  - `bidi.ts` 5: 初回応答 4 経路（publish / subscribe / fetch / trackStatus）+ `bidiReadRequestStreamMessages`
  - `session.ts` 2: `handleGoawayOnNamespaceStream`、PUBLISH 後続ループの GOAWAY 分岐
- `src/message/session.prop.ts`: Request ID 付きラウンドトリップ PBT と `isValidGoawayRequestIdParity` PBT がある。`validateGoawayOnRequestStream` の単体テストは無い（`bidi.test.ts` にあるのは重複検出のみで残す）

公開 `Session.goaway(newSessionUri?, timeout?)` に `requestId` 引数は無い。パッケージ公開 API は非破壊。破壊は内部 `src/message` barrel 利用者向け（`Goaway.requestId` / `isValidGoawayRequestIdParity` 削除）に限る。

open `#0302`（session モジュール分割）は `validateGoawayOnRequestStream` 呼び出し前提の記述を含む。本変更後に `#0302` の refresh が必要。

## 設計方針

- `Goaway` 型から `requestId` を削除する
- `encodeGoawayPayload` / `decodeGoawayPayload` から Request ID 処理を削除する。Timeout 消費後に `offset !== data.length` なら即 ProtocolViolationError にする（varint として解釈しない）
  - 実装対応の先例: REQUEST_ERROR の trailing（`trailing data after Redirect in REQUEST_ERROR: expected … consumed …`）。GOAWAY も同様に `expected` / `consumed` を含める
  - 仕様上の裏付け: Section 10 制御メッセージ共通部の Length と Message Body 不一致 → PROTOCOL_VIOLATION MUST。旧 Request ID バイトは型定義 Body 消費後の余剰になる
- `isValidGoawayRequestIdParity` を削除し、`src/message/index.ts` の再エクスポートも外す
- `validateGoawayOnRequestStream` の定義と上記 7 呼び出しをすべて除去する。削除後は `decodeGoawayPayload` → コールバック / state 更新のみ残す。JSDoc の Request ID null チェック言及も同時削除
- `validateNoDuplicateGoawayOnRequestStream` は残す（draft-19 Section 10.4 でも制御 / 単一 request stream の複数 GOAWAY は PROTOCOL_VIOLATION）
- `handleGoaway` の Request ID 欠落チェックとパリティ検証を削除する。制御ストリームで Request ID なし GOAWAY を正常受信できるようにする
- **制御ストリームの trailing でも PROTOCOL_VIOLATION でセッションを閉じる**: `receivedGoaway = true` は decode 成功後に移す。`handleGoaway` 内で `ProtocolViolationError` を catch し `closeWithError(toProtocolViolationSessionError(...))` に変換する。これがないと draft-18 の Request ID 付き制御ストリーム GOAWAY が「`receivedGoaway` だけ立つ半端状態」になる
- `goaway()` 送信から `requestId: 1n` を除去する
- 本変更で編集したファイル内の Request ID / draft-18 GOAWAY コメントだけを draft-19 Section 10.4 に更新する。リポジトリ全体の `draft-18` 置換・README の「GOAWAY / Request ID 対応」文言更新は 0343（または別途）の担当とし、本 issue の完了条件に含めない
- `CHANGES.md` の `## develop` に `[CHANGE]` で Request ID 削除を明記する
- 後方互換は取らない（プロジェクト規約どおり）。ワイヤも draft-19 専用とする

## 完了条件

- Request ID を含まない GOAWAY のエンコード・デコードが Section 10.4 のワイヤフォーマットと一致すること（`src/message/session.prop.ts` ラウンドトリップで担保）
- 制御ストリームで Request ID なし GOAWAY を受信してもセッションが PROTOCOL_VIOLATION / INVALID_REQUEST_ID で切れないこと。担保は `handleGoaway` から Request ID チェックを削除し、上記ラウンドトリップと既存テスト通過で足りる（モック禁止のため制御ストリーム E2E は必須としない）
- Timeout 消費後に余分なバイトを持つ GOAWAY の `decodeGoawayPayload` が ProtocolViolationError を throw するテストがあること（`src/message/session.prop.ts`）
- 制御ストリーム経路で trailing GOAWAY を受けたとき、セッションが PROTOCOL_VIOLATION で閉じること（`receivedGoaway` だけ立つ半端状態にならないこと）。担保は `handleGoaway` の `closeWithError` 配線のコード確認で足り、E2E は必須としない
- `src/message/session.prop.ts` の Request ID 付きラウンドトリップとパリティ PBT が削除または新フォーマットに置き換わっていること
- 本変更で編集したファイル内から `isValidGoawayRequestIdParity` / `validateGoawayOnRequestStream` / `Goaway.requestId` / GOAWAY 文脈の `requestId: 1n` が消えていること（他メッセージの `requestId`、未編集ファイルの draft-18 コメント、README は対象外）
- `validateNoDuplicateGoawayOnRequestStream` が残っていること
- `CHANGES.md` に `[CHANGE]` エントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/session.ts`: 型・encode・decode・`isValidGoawayRequestIdParity` を更新 / 削除。Timeout 後の trailing を即 ProtocolViolationError にする（`expected` / `consumed` 付き）
2. `src/message/index.ts`: `isValidGoawayRequestIdParity` の再エクスポートを削除
3. `src/message/session.prop.ts`: ラウンドトリップから `requestId` を除去。パリティ PBT を削除。Timeout 後余剰バイトの ProtocolViolation テストを追加
4. `src/session.ts`（呼び出し 2 箇所 + 制御経路）: `goaway()` / `handleGoaway` / `handleGoawayOnNamespaceStream` / PUBLISH 後続 GOAWAY 分岐から Request ID 検証を除去。`handleGoaway` で decode 成功後に `receivedGoaway` を立て、trailing を `closeWithError` で PROTOCOL_VIOLATION にする。関連 import・JSDoc を更新
5. `src/session/bidi.ts`（呼び出し 5 箇所）: `validateGoawayOnRequestStream` 定義と 5 呼び出しを除去（重複検出は残す）。全体 7 = 手順 4 の 2 + 手順 5 の 5
6. `CHANGES.md`: `[CHANGE] GOAWAY メッセージから Request ID を削除する` を追記
7. `vp check` / `tsc --noEmit` / `vp test run` で確認
8. open `#0302` は本変更後に refresh が必要な旨を実装 PR / 作業メモで残す（本 issue では `#0302` を編集しない）
