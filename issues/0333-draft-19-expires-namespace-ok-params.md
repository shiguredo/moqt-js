# SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK で EXPIRES を許可する (draft-19 追従)

- Priority: High
- Created: 2026-07-07
- Model: Fable 5
- Branch: feature/change-draft-19-expires-namespace-ok
- Polished: 2026-07-23

## 目的

draft-ietf-moq-transport-19 Section 10.2.15 (EXPIRES Parameter) で、EXPIRES を付けられるメッセージが拡張されている。

draft-19 Section 10.2.15:

> The EXPIRES parameter (Parameter Type 0x8) is a varint. It MAY
> appear in SUBSCRIBE_OK, PUBLISH, PUBLISH_OK, SUBSCRIBE_NAMESPACE_OK,
> SUBSCRIBE_TRACKS_OK, PUBLISH_NAMESPACE_OK, or REQUEST_UPDATE_OK.

Parameter Type は `0x8`（コード上は `0x08`）。SUBSCRIBE_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK / PUBLISH_NAMESPACE_OK の 3 メッセージが、draft-18 時点の許可集合に対する追加分である。

許可外パラメータは Section 10.2.1 (Parameter Scope) により PROTOCOL_VIOLATION でセッションを閉じなければならない。

## 優先度根拠

High。実害があるのは次の 2 経路である。

- SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK: `EMPTY_ALLOWED_PARAMS`（空集合）でスコープ検証しているため、draft-19 準拠サーバーが EXPIRES を付けると `SessionError(PROTOCOL_VIOLATION)` でセッション全体を誤切断する
- SUBSCRIBE_TRACKS_OK: 現状は `decodeRequestOkPayload` / `validateParameterScope` を呼んでおらず、EXPIRES 付きでも切断しない。本変更で検証を入れるとき、許可集合追加と decode+validate 追加を同一変更で行わないと、逆に新規の誤切断を起こす

## 現状

シンボル名を正とする。

- `src/message/parameterScope.ts`: `EMPTY_ALLOWED_PARAMS` は空集合。コメントには SUBSCRIBE_TRACKS_OK も含まれるが、**実行時の使用は SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の 2 経路のみ**
- `validateParameterScope` は許可外パラメータで `SessionError(PROTOCOL_VIOLATION)` を渡しセッションを閉じる
- `SUBSCRIBE_OK_ALLOWED_PARAMS` / `PUBLISH_OK_ALLOWED_PARAMS` / `REQUEST_UPDATE_OK_ALLOWED_PARAMS` / `PUBLISH_ALLOWED_PARAMS` には既に EXPIRES がある
- `MessageParameterType.EXPIRES: 0x08` は定義済み
- `src/session.ts` `startNamespaceStreamLoop` / `startNamespacePublicationStreamLoop`: REQUEST_OK で `EMPTY_ALLOWED_PARAMS` を使用。コメントも「許可パラメータは空」のまま
- `src/session.ts` `startTracksStreamLoop` の REQUEST_OK: `decodeRequestOkPayload` も `validateParameterScope` も呼ばず、即 `createTracksSubscription` する。payload 未デコードのため現状 EXPIRES でも PROTOCOL_VIOLATION にならない
- 既存の SUBSCRIBE_OK / REQUEST_UPDATE_OK 受信はスコープ通過後に LARGEST_OBJECT 等だけ抽出し、EXPIRES 値は読まない（タイマー・API 公開なし）。`NamespaceSubscription` / `TracksSubscription` にも `expires` フィールドはない

closed `#0272` で SUBSCRIBE_TRACKS_OK の Track Properties 空チェック付き decode が消えた経緯がある。draft-19 Section 10.5 の Track Properties 空必須一覧は PUBLISH_OK / REQUEST_UPDATE_OK / SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK のみで、SUBSCRIBE_TRACKS_OK は含まない。本変更で空チェックを再導入してはならない。

## 設計方針

- EXPIRES のみを含む許可パラメータ定数を新設する（名称は実装時判断。例: `NAMESPACE_OR_TRACKS_OK_ALLOWED_PARAMS`。TRACKS_OK も含むので `NAMESPACE_OK_*` だけだと紛らわしい）。`EMPTY_ALLOWED_PARAMS` を EXPIRES 入りに改名流用しない
- SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の検証を新定数に置き換え、「許可パラメータは空」コメントを直す。既存の `validateRequestOkNoTrackProperties` はそのまま維持する
- SUBSCRIBE_TRACKS_OK では **先に** 新定数を用意したうえで、`decodeRequestOkPayload` → 新定数での `validateParameterScope` を追加する。空集合のまま検証だけ先に入れない。Track Properties 空チェックは付けない
- 本 issue の範囲は受信側の許可集合更新とスコープ検証の通過まで。送信側（クライアントがこれら OK を送る経路）・EXPIRES の解釈・タイマー・`REQUEST_UPDATE` 延長・コールバック / `expires` API 公開は対象外。既存 SUBSCRIBE_OK と同様、検証通過後に値は利用しない
- 本変更で触るファイルの仕様参照だけ draft-19 Section 10.2.15 / 10.2.1 に更新する。リポジトリ全体の draft-18 一掃は `#0343`
- `EMPTY_ALLOWED_PARAMS` が未使用になれば削除する（`FETCH_OK_ALLOWED_PARAMS` は別定数のため残す）
- `CHANGES.md` の `## develop` に `[FIX]` または `[UPDATE]` で、当該 OK に EXPIRES を許可する旨を追記する

## 完了条件

- 新許可集合が EXPIRES のみを含み、`validateParameterScope` が EXPIRES で通過・未許可 type で `SessionError(PROTOCOL_VIOLATION)` になる単体テストがあること（`parameterScope` 単位。モック禁止）
- SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK / SUBSCRIBE_TRACKS_OK の 3 経路が新定数（または同等）を参照していることをコードレビューで確認できること。session private ループを非モックで駆動するハーネスが無いため、経路ごとの受信 E2E は必須としない（closed `#0322` と同様、集合 + `validateParameterScope` 単体を主担保とする）
- SUBSCRIBE_TRACKS_OK 経路に `decodeRequestOkPayload` とスコープ検証の呼び出しが追加されていること
- Track Properties 空チェックが SUBSCRIBE_TRACKS_OK に再導入されていないこと
- `CHANGES.md` にエントリがあること
- lint / build / typecheck / 既存テストが通ること

## 解決方法

1. `src/message/parameterScope.ts`: EXPIRES のみの許可定数を新設。コメントに draft-19 Section 10.2.15。未使用なら `EMPTY_ALLOWED_PARAMS` を削除
2. `src/session.ts`: SUBSCRIBE_NAMESPACE_OK / PUBLISH_NAMESPACE_OK の `EMPTY_ALLOWED_PARAMS` を新定数に置換。コメント更新。`validateRequestOkNoTrackProperties` は維持
3. `src/session.ts` `startTracksStreamLoop` の REQUEST_OK: `decodeRequestOkPayload` → 新定数で `validateParameterScope` を追加（Track Properties 空チェックは付けない）。`resolved = true` / `resolve` は検証成功後に置く（`startNamespaceStreamLoop` と同順。現状の TRACKS 経路は検証前に `resolved = true` している）
4. テスト: `src/message/parameterScope.test.ts`（または同等）で新集合と `validateParameterScope` の通過 / 拒否を検証。モック禁止
5. 触った箇所の仕様参照を draft-19 に更新
6. `CHANGES.md` にエントリを追記
7. `vp check` / `tsc --noEmit` / `vp test run` で確認
