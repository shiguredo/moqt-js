# 未使用の export (calculateAuthTokenSize / fallbackRegisterToUseValue / ObjectForwardingPreference) を削除する

- Priority: Medium
- Created: 2026-08-06
- Completed: 2026-08-13
- Model: DeepSeek V4 Flash
- Branch: feature/refactor-moqt-draft-19-remove-unused-exports
- Polished: 2026-08-12

## 目的

どこからも import されていない export を削除し、デッドコードを排除する。`calculateAuthTokenSize` / `fallbackRegisterToUseValue` は closed issue 0331 (MAX_AUTH_TOKEN_CACHE_SIZE) で追加された未配線のヘルパーであり、`ObjectForwardingPreference` は closed issue 0239 で draft-18 §11.2.1 に基づき追加された enum である。いずれも draft-19 の実装では使われる場所がない。

## 優先度根拠

3 件ともリポジトリ全体 (テスト・index.ts を含む) から一切参照されておらず、`src/index.ts` / `src/message/index.ts` からも re-export されていない (詳細は現状参照)。完全なデッドコードであり、削除による影響はない。draft-19 対応バッチ内での一括整理の一環として対応する。Medium。

## 現状

- `calculateAuthTokenSize` (`src/message/authorizationToken.ts`) — 全コード・テストから未参照。index.ts / message/index.ts からも未 re-export。
- `fallbackRegisterToUseValue` (`src/message/authorizationToken.ts`) — 同上。REGISTER → USE_VALUE フォールバックは §10.3.1.4 の受信側 (endpoint) 処理であり、moqt-js の受信処理に配線されていない。
- `ObjectForwardingPreference` (`src/message/types.ts`) — 全コード・テストから未参照。draft-19 §11.2.1 には「Object Forwarding Preference: An enumeration indicating how a publisher sends an object. The preferences are Subgroup and Datagram.」として概念が残存するが、wire 上は明示フィールドが存在せず、Subgroup ストリーム (§11.4.2 の「All Objects received on a stream opened with SUBGROUP_HEADER have an Object Forwarding Preference = Subgroup.」) と Object Datagram (§11.3.1) の使い分けで暗黙に表現されるため、enum 定数として使う場所がない。
- 変更対象ファイル: `src/message/authorizationToken.ts` / `src/message/types.ts` (3 シンボルの定義と doc コメントの削除)、`CHANGES.md`。

## 設計方針

- 上記 3 シンボルの定義を削除する (doc コメントはシンボルとともに除去される)。
- 本 issue のスコープ外: 3 シンボル以外の draft-18 言及コメント (例: `src/session.ts` 等の残存コメント) は一括更新 (0343 相当) の対象であり、本 issue では扱わない。
- 削除後に `tsc --noEmit` とテストが通ることを確認する。

## 完了条件

- 3 シンボルが削除され、リポジトリ内に参照が残らないこと。
- `CHANGES.md` の `## develop` の `### misc` に `[CHANGE]` エントリがあること (シンボル削除を伴う変更の先例に従い [CHANGE] で記載する。先例: 「[CHANGE] PublishOk 型と encodePublishOkPayload を削除する (#0290)」)。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §11.2.1 (Object Header / Object Forwarding Preference の概念)
- draft-ietf-moq-transport-19 §11.3 (Datagrams / Object Forwarding Preference = Datagram)
- draft-ietf-moq-transport-19 §11.4.2 (Subgroup Header / Object Forwarding Preference = Subgroup)
- draft-ietf-moq-transport-19 §10.3.1.3 (MAX_AUTH_TOKEN_CACHE_SIZE / token size)
- draft-ietf-moq-transport-19 §10.3.1.4 (AUTHORIZATION TOKEN / REGISTER → USE_VALUE フォールバック)
- 関連: `issues/closed/0239-draft-18-add-object-forwarding-preference-enum.md`（`ObjectForwardingPreference` 導入元）
- 関連: `issues/closed/0331-bug-setup-authorization-token-validation.md`（`calculateAuthTokenSize` / `fallbackRegisterToUseValue` 導入元）
- 関連: `0390-moqt-draft-19-unexport-internal-symbols.md`（同一ファイル内でしか使われていない export の非公開化。本 issue の完全未参照の削除とは対象が異なる）
- 関連: `0394-refactor-unify-max-varint-constant.md`（同じ `### misc` にエントリを並べる。0394 の完了条件の `[REFACTOR]` は shiguredo-changelog 規約にない種別のため、0394 側で修正すること）

## 解決方法

- `src/message/authorizationToken.ts` から `calculateAuthTokenSize` / `fallbackRegisterToUseValue` を削除した (リポジトリ全体から参照されていないデッドコード。doc コメントも併せて削除)
- `src/message/types.ts` から `ObjectForwardingPreference` (const + type) を削除した (draft-19 では wire 上の明示フィールドがなく、Subgroup ストリームと Object Datagram の使い分けで暗黙に表現されるため使用箇所がない)
- `AuthorizationTokenRegister` / `AuthorizationTokenUseValue` 型は `AuthorizationToken` discriminated union の構成要素として必要であり、削除しない
- `CHANGES.md` の `## develop` 末尾に `### misc` セクションを追加し、`[CHANGE]` エントリを記載した (シンボル削除を伴う変更の先例に従い [CHANGE] で記載)
