# FETCH_OK / REQUEST_UPDATE_OK / TRACK_STATUS_OK のパラメータ処理を修正する

- Priority: Medium
- Created: 2026-06-17
- Model: Opus 4.8
- Branch: feature/fix-request-ok-parameter-handling
- Polished: 2026-06-20

## 目的

`FETCH_OK`、`REQUEST_UPDATE_OK`、`TRACK_STATUS_OK` の各 OK 応答メッセージにおけるパラメータの許可/禁止/検証を draft-ietf-moq-transport-18 に合わせて修正する。

## 優先度根拠

パラメータ処理の誤りは相互運用時に問題を引き起こす。特に `FETCH_OK` に許可されていない `EXPIRES` と `LARGEST_OBJECT` を許可しており、`GROUP_ORDER` を読み取ろうとしている点は draft 違反。また `TRACK_STATUS_OK` のパラメータ検証が欠落している。現状の主要フローが即座に破綻しないため Medium。

## 現状

3 つの問題がある:

### 1. `FETCH_OK_ALLOWED_PARAMS` の誤り (`src/message/parameterScope.ts` L83-L87)

```typescript
export const FETCH_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.EXPIRES,        // ← draft では FETCH_OK に許可されない
  MessageParameterType.LARGEST_OBJECT,   // ← draft では FETCH_OK に許可されない
]);
```

### 2. `REQUEST_UPDATE_OK_ALLOWED_PARAMS` の欠落 (`src/message/parameterScope.ts` L51-L53)

```typescript
export const REQUEST_UPDATE_OK_ALLOWED_PARAMS = new Set<number>([
  MessageParameterType.LARGEST_OBJECT,
  // EXPIRES が欠落している
]);
```

### 3. `bidiReadFetchResponse` の `GROUP_ORDER` 読み取り (`src/session/bidi.ts` L519-L527)

`FETCH_OK` から `GROUP_ORDER` パラメータを `find()` で読み取ろうとしている。draft では `FETCH_OK` に `GROUP_ORDER` は許可されない。

### 4. `bidiReadTrackStatusResponse` のパラメータ検証欠落 (`src/session/bidi.ts` L596-L600)

`decodeRequestOkPayload` から得た `parameters` をそのまま resolve しており、`validateParameterScope` による `TRACK_STATUS_OK_ALLOWED_PARAMS` の検証が行われていない。

## 仕様根拠

draft-ietf-moq-transport-18:

- **§10.2.8 (GROUP_ORDER)**: `SUBSCRIBE_OK` に許可されるが `FETCH_OK` には許可されない
- **§10.2.10 (EXPIRES)**: `SUBSCRIBE_OK`、`REQUEST_UPDATE_OK` に出現可能。`FETCH_OK` には許可されない
- **§10.2.11 (LARGEST_OBJECT)**: `SUBSCRIBE_OK`、`REQUEST_UPDATE_OK` に許可されるが `FETCH_OK` には許可されない
- **§10.2.1 (Parameter Scope)**: 許可されたパラメータのみを受理する MUST

## 設計方針

1. `FETCH_OK_ALLOWED_PARAMS` から `EXPIRES` と `LARGEST_OBJECT` を削除する
2. `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に `EXPIRES` を追加する
3. `bidiReadFetchResponse` から `GROUP_ORDER` の find 処理を削除する
4. `bidiReadTrackStatusResponse` で `validateParameterScope` を用いてパラメータを検証する

## 変更対象ファイル

- `src/message/parameterScope.ts`: 2 箇所修正（FETCH_OK_ALLOWED_PARAMS から EXPIRES/LARGEST_OBJECT 削除、REQUEST_UPDATE_OK_ALLOWED_PARAMS に EXPIRES 追加）
- `src/session/bidi.ts`: 2 箇所修正（bidiReadFetchResponse の GROUP_ORDER 削除、bidiReadTrackStatusResponse のパラメータ検証追加）
- `CHANGES.md` に `[FIX]` エントリを追記する

### setFetchOkInfo のデッドコード化について

GROUP_ORDER 抽出コードを削除した後、`setFetchOkInfo` (`src/fetcher.ts` L114-126) の `groupOrder` パラメータには常に `undefined` が渡される。`FetcherImpl.fetchGroupOrder` フィールドは削除せず、将来 FETCH リクエスト側から groupOrder を設定できるようコメントを残す。

## テスト方針

- 既存の全テストが PASS することを必須とする
- `src/message/parameterScope.test.ts` を新設し以下をテストする:
  - `FETCH_OK_ALLOWED_PARAMS` が `EXPIRES` と `LARGEST_OBJECT` を含まないこと
  - `REQUEST_UPDATE_OK_ALLOWED_PARAMS` が `EXPIRES` を含むこと
- `src/session/bidi.test.ts` に以下を追加する:
  - FETCH_OK に許可外パラメータが含まれる場合に `closeWithError(PROTOCOL_VIOLATION)` が呼ばれること
  - TRACK_STATUS_OK のパラメータが正しく検証されること

## 完了条件

- `FETCH_OK_ALLOWED_PARAMS` から `EXPIRES` と `LARGEST_OBJECT` が削除される
- `REQUEST_UPDATE_OK_ALLOWED_PARAMS` に `EXPIRES` が追加される
- `bidiReadFetchResponse` が `GROUP_ORDER` を読み取らなくなる
- `bidiReadTrackStatusResponse` がパラメータを検証する
- 既存の全テストが PASS する
- `CHANGES.md` に `[FIX]` エントリが追記される
