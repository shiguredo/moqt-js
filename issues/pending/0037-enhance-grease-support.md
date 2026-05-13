# GREASE 送信の実装

## 概要

draft-ietf-moq-transport-17 Section 13 で定義されている GREASE (Generate Random Extensions And Sustain Extensibility) の送信機能が未実装である。
現在は受信側の処理 (未知の値を無視する) は対応済みだが、送信側で GREASE 値を積極的に送る処理がない。

## 仕様

### RFC 参照

- draft-ietf-moq-transport-17 Section 13
- draft-ietf-moq-transport-17 Section 5.3

### GREASE 値のパターン

```
0x7f * N + 0x9D (N = 0, 1, 2, ...)
```

具体例: `0x9D`, `0x11C`, `0x19B`, `0x21A`, ...

最大値: `0x3ffffffffffffffe`

### GREASE が適用されるレジストリ

| レジストリ                      | RFC セクション | 用途                         |
| ------------------------------- | -------------- | ---------------------------- |
| Setup Options                   | Section 9.4.1  | SETUP メッセージのオプション |
| Properties                      | Section 14.4   | Track / Object Properties    |
| Session Termination Error Codes | Section 14.5.1 | セッション終了エラー         |
| REQUEST_ERROR Codes             | Section 14.5.2 | リクエストエラー             |
| PUBLISH_DONE Codes              | Section 14.5.3 | PUBLISH_DONE ステータス      |
| Data Stream Reset Error Codes   | Section 14.5.4 | データストリームリセット     |
| MOQT Auth Token Type            | -              | 認証トークン種別             |

### RFC の要件レベル

RFC では GREASE に関して以下のように記述されている:

- **受信側**: MUST として未知の値を gracefully にハンドルすること
- **送信側**: SHOULD レベルの推奨 (MUST ではない)

> Implementations MUST handle unknown values from these registries gracefully.

> Setup Options with reserved identifiers carry arbitrary values and have no semantics.

## 現在の実装状況

### 受信側 (対応済み)

- Setup Options の未知の Option Type は無視される (`src/message/setup.ts`)
- Object Properties の未知のプロパティ ID は無視される (`src/dataStream.ts`)

### 送信側 (未実装)

以下の箇所で GREASE 値を送信する処理がない:

1. **SETUP メッセージ**: `src/session.ts` の `initialize()` で送信する SETUP メッセージに GREASE Setup Option を含めていない
2. **Object Properties**: `src/dataStream.ts` の `encodeObjectFields()` で GREASE プロパティを含めていない
3. **Track Properties**: `src/properties.ts` で GREASE Track Property を含めていない

## 実装方針

### 1. GREASE 値生成ユーティリティ

```typescript
function generateGreaseValue(): bigint {
  const n = BigInt(Math.floor(Math.random() * 100));
  return 0x7fn * n + 0x9dn;
}
```

### 2. 送信対象の優先順位

GREASE はインターオペラビリティの確保が目的であるため、相手側の実装が未知の値を正しく無視できることを検証するのが重要である。

1. **Setup Options** (最も効果的): 全セッション開始時に 1 回送信される。相手が未知 Option を無視できるか検証できる
2. **Object Properties**: 送信頻度が高いため性能への影響を考慮する必要がある
3. **Track Properties**: PUBLISH / SUBSCRIBE_OK / FETCH_OK で送信される

### 3. 設計判断が必要な点

- GREASE を常に送信するか、確率的に送信するか (例: 10% の確率)
- GREASE の値とペイロードのサイズ制限
- GREASE 送信を無効化するオプションの提供

## 影響範囲

- `src/session.ts`: SETUP メッセージ送信時の GREASE Option 追加
- `src/message/setup.ts`: GREASE Setup Option のエンコード
- `src/dataStream.ts`: Object Properties への GREASE 追加 (任意)
- `src/properties.ts`: Track Properties への GREASE 追加 (任意)

## pending 理由

GREASE は RFC では SHOULD レベルの推奨であり、送信頻度や対象の設計判断が必要。また、相手側の実装が GREASE を正しく処理できない場合の接続性リスクがあるため、実装タイミングと範囲の判断が必要。

## 調査結果

**送信側 GREASE は未実装のまま**

- `src/grease.ts` には `isGreaseValue()` と `generateGreaseValue()` があるが、これは値判定と値生成の helper に留まっている。
- `generateGreaseValue()` の現在の API は `generateGreaseValue(n: number)` であり、issue 本文にある「乱数で都度生成する helper」とは実装形が異なる。
- 利用箇所を確認すると、`generateGreaseValue()` / `isGreaseValue()` はランタイムの送信パスから参照されていない。
- `src/message/setup.ts` の `createSetup()` は `PATH` / `AUTHORIZATION_TOKEN` / `AUTHORITY` / `MOQT_IMPLEMENTATION` しか積んでおらず、GREASE Setup Option を追加しない。
- `src/session.ts` の `publish()` は concrete な `TrackPropertyId` だけを組み立てており、GREASE Track Property を挿入しない。
- `src/session.ts` の `sendObjectInternal()` / `sendDatagram()` も、呼び出し元から渡された `properties` をそのまま送るだけで、自動 GREASE 注入はしない。
- 以上から、現状は「helper はあるが送信への配線がない」状態であり、issue の本体は未解決である。

## 今どうするべきか

- 当面は `issues/pending/` のまま維持するのが妥当である。
- もし着手するなら、まずは影響範囲が最も限定的な `SETUP` Option への opt-in な GREASE 送信から始めるべきである。
- `Object Properties` や `Track Properties` への GREASE 注入は、相互接続確認と性能影響の見積もりを別途行った上で後続 issue に分けるべきである。

## 状況確認 (2026-04-29)

- `src/grease.ts:37-54` を再確認。`isGreaseValue()` / `generateGreaseValue(n: number)` は前回調査時の API のまま。
- `src/message/setup.ts:39-80` の `createSetup()` は依然として `PATH` / `AUTHORIZATION_TOKEN` / `AUTHORITY` / `MOQT_IMPLEMENTATION` のみを追加。GREASE Setup Option を入れる経路はなし。
- `src/session.ts` 内のオブジェクト送信パス (`sendObjectInternal()` / `sendDatagram()`) からも `grease.ts` の参照は出ておらず、自動 GREASE 注入は未配線のまま。
- 送信側 GREASE は引き続き未実装。pending 維持で変更なし。
