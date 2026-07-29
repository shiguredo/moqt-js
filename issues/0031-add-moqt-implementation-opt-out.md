# MOQT_IMPLEMENTATION の opt-out / override 機構を追加する

- Priority: Low
- Created: 2026-03-16
- Completed: YYYY-MM-DD
- Model: manual
- Branch: feature/add-moqt-implementation-opt-out
- Polished: 2026-07-30

## 目的

draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting) が規定するプライバシー緩和策に対応する。MOQT_IMPLEMENTATION Setup Option の送信を利用者が制御できるようにし、フィンガープリンティングリスクを低減する。

## 現状

- `src/message/setup.ts` の `createSetup()` は MOQT_IMPLEMENTATION (0x07) を無条件で push している。送信を無効化・変更する分岐は存在しない
- `src/session.ts` の `initialize()` は `createSetup()` を呼び SETUP を送信しており、MOQT_IMPLEMENTATION だけを抑止する option を持っていない
- `src/version.ts` の `MOQT_IMPLEMENTATION_VALUE` は `moqt-js/${version}`（フル semver）であり、§13.8 の "Implementations SHOULD send only the minimum information necessary" に照らすと送信内容自体の見直し余地もある
- `src/index.ts` は `MOQT_IMPLEMENTATION_VALUE` を公開 API として再エクスポートしている

## 設計方針

draft-ietf-moq-transport-19 §10.3.1.5: "An endpoint SHOULD send a MOQT_IMPLEMENTATION option unless specifically configured not to do so."

draft-ietf-moq-transport-19 §13.8:

- "Privacy-conscious deployments MAY omit the MOQT_IMPLEMENTATION option entirely or send a generic value."
- "Implementations MAY provide users with the ability to configure or disable the MOQT_IMPLEMENTATION option."

方針:

1. 既定は現状どおり送信を維持する（§10.3.1.5 の SHOULD に従う）
2. `ConnectOptions` に opt-out / override のオプションを追加する
   - opt-out: MOQT_IMPLEMENTATION を送信しない（boolean フラグ）
   - override: カスタム値を設定する（string）
   - 両方を 1 つのフィールドで表現する（例: `moqtImplementation?: string | false`。`undefined` = 既定値送信、`false` = 送信しない、`string` = カスタム値）
3. `ConnectOptions` → `initialize()` → `createSetup()` の呼び出しチェーンでオプションを中継する
4. `createSetup()` 内で `undefined` / `false` / `string` の三択分岐で push / skip を制御する

## 完了条件

- `ConnectOptions` で MOQT_IMPLEMENTATION の送信停止・カスタム値の設定ができる
- 既定（オプション未指定）では現状どおり `moqt-js/${version}` が送信される
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 解決方法

### 変更対象

- `src/message/setup.ts`: `createSetup()` の options に `moqtImplementation?: string | false` を追加し、条件付きで push / skip する
- `src/session.ts`: `ConnectOptions` インターフェースに同フィールドを追加し、`initialize()` から `createSetup()` に中継する
- `src/index.ts`: `connect()` から `initialize()` への呼び出しで同フィールドを中継する
- `src/message/setup.test.ts`: opt-out / override のテストを追加する

### 参照

- draft-ietf-moq-transport-19 §13.8 (Implementation Identification Fingerprinting)
- draft-ietf-moq-transport-19 §10.3.1.5 (MOQT IMPLEMENTATION)

## reopened にする理由

draft-ietf-moq-transport-19 §13.8 がプライバシー緩和を具体化したため着手可能になった。

- Implementations SHOULD send only the minimum information necessary
- Privacy-conscious deployments MAY omit the option entirely or send a generic value
- Implementations MAY provide users with the ability to configure or disable the option

設計方針は draft-19 に合わせて固定する。既定は現状どおり送信を維持し、`ConnectOptions` で opt-out / override を提供する。
