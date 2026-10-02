# SETUP での拡張機能宣言の明確化に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-setup-extension-negotiation
- Polished: 2026-10-02

## 目的

draft-ietf-moq-transport-22 §6.3.2 (Extension Negotiation) は、拡張機能のサポートを SETUP の Setup Option で宣言し、汎用の宣言形式は無く各拡張仕様が Option の型・値・交渉規則を定めると明確化した (#1921)。Setup Option は IANA に登録する (§16.4)。v21 の §6.3.2 には「汎用の宣言形式は無い」という記述と §16.4 への参照が無く、moqt-js の SETUP 関連コメントにも拡張宣言の仕組みの説明が無い。

あわせて、v22 では §1.5 が Response Message Naming になり、Modularity (「Limited endpoints SHOULD respond to any unsupported messages with the appropriate NOT_SUPPORTED error code, rather than ignoring them.」) は §1.6 に移動した。moqt-js はこの文を "§1.5 (Extensibility)" と参照しているが、v21 でこの文は §1.5 (Modularity) にあり「Extensibility」という節名は v21 には存在しない (Extensibility は draft-18〜20 の §4)。また `src/session/connection.ts` の `connectionInitialize` と `src/session.ts` のフィールド JSDoc は制御ストリームの単方向ペア化の説明に "Section 1.5 (Extensibility)" を付しており、その正文は §6.3 (Session initialization) にある (v21 / v22 共通)。これらを v22 の正しい節に更新し、SETUP の扱いが新しい記述と整合することを確認する。

## 現状

- "§1.5 (Extensibility)" 参照は 6 ファイル 12 箇所にあり、2 種の内容に分かれる:
  - NOT_SUPPORTED SHOULD の引用: `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` docstring / `incomingHandleFirstBidiMessage` の docstring ("§1.5 SHOULD") と関数内コメント / `incomingIsRejectedNamespaceRequest` docstring、`src/session/incomingPublish.ts`、`src/session/incoming.prop.ts` (モジュールヘッダーと 1 箇所)、`src/session/incoming.test.ts` (NOT_SUPPORTED テストの JSDoc)。正文は v22 §1.6 (Modularity)
  - 制御ストリームの単方向ペア化の説明: `src/session/connection.ts` の `connectionInitialize`、`src/session.ts` の `controlSendStream` など制御ストリームのフィールド JSDoc。正文は §6.3 (Session initialization)
- `src/message/setup.ts` の `decodeSetupPayload` は未知の Setup Option を解釈せずパラメータ配列に保持するだけで拒否しない (コメントは「未知の Setup Option は MUST ignore（§9.1）」)。`encodeSetupPayload` は渡された `msg.parameters` をそのまま符号化し、`createSetup` が積むのは AUTHORIZATION_TOKEN (0x03) / MAX_AUTH_TOKEN_CACHE_SIZE (0x04) / MAX_FILTER_RANGES (0x06) / MOQT_IMPLEMENTATION (0x07) / MAX_REQUEST_UPDATES (0x08) と GREASE のみ。PATH (0x01) / AUTHORITY (0x05) は WebTransport 使用時の MUST NOT (§9.1.1 / §9.1.2) のため `createSetup` に積む手段を持たない
- `src/session/connection.ts` の `connectionDecodeAndValidateSetup` は受信した Option を読み、`session.peerMaxRequestUpdates` / `session.peerMaxFilterRanges` を保持し、`peerMaxAuthTokenCacheSize` をログ出力用に取り出す
- Setup Option と Message Parameter は別のレジストリであり、SETUP に Message Parameter は出現しない (§9.20.1)
- `src/message/setup.ts` と `src/message/parameter/kvp.ts` は Key-Value-Pairs を "Figure 2" と書くが、v22 §9.1 では "Figure 3" (SETUP Message は Figure 6)
- 節番号参照は v21 のまま (`src/message/setup.ts` / `src/message/parameter/kvp.ts` / `src/session/connection.ts` の §9.1 系。§9.1.1〜§9.1.7 の番号は v22 でも同じ)

## 設計方針

- "§1.5 (Extensibility)" 参照を v22 の正しい節に修正する:
  - NOT_SUPPORTED SHOULD の引用 → draft-ietf-moq-transport-22 §1.6 (Modularity)
  - 制御ストリームの単方向ペア化 → §6.3 (Session initialization)
  - 「Extensibility」という節名への言及は残さない
- `src/message/setup.ts` に v22 §6.3.2 / §9.1 / §16.4 の拡張宣言の仕組みをコメントで整理する:
  - 各拡張仕様が Setup Option を定義し、汎用の宣言形式は無い (§6.3.2)。将来の拡張追加時に汎用形式を仮定しないことをコメントに残す
  - Setup Option は §16.4 で IANA に登録され、未知の Option は §9.1 の MUST (ignore、unknown の重複許容) に従う
  - Setup Option の名前空間は Message Parameter と別 (§9.1 / §9.20.1)
  - moqt-js が宣言する Setup Option の一覧を §16.4 Table 11 と照合して整理する (送るもの: 0x03 / 0x04 / 0x06 / 0x07 / 0x08 / GREASE。送らないもの: PATH / AUTHORITY - WebTransport の MUST NOT)
- `decodeSetupPayload` の「未知 Setup Option は MUST ignore」コメントの参照を v22 の §9.1 / §16.4 に更新し、実装 (保持して拒否しない + 呼び出し側が既知のみ参照) が §9.1 と整合することを確認する
- `src/message/parameter/kvp.ts` の Key-Value-Pairs 参照 (Figure 2 → Figure 3) を v22 に更新する
- 挙動は変えない。既存テスト (`src/message/setup.test.ts` / `src/message/setup.prop.ts`) が現行挙動を固定していることを確認し、未知 Option の扱いを固定するテストが無ければ追加する

## 完了条件

- "§1.5 (Extensibility)" の参照が `src/` に残っていない (NOT_SUPPORTED SHOULD は §1.6 (Modularity)、制御ストリームの単方向ペア化は §6.3 を指す)
- 拡張宣言の仕組み (§6.3.2) と Setup Option の扱い (§9.1 / §16.4 / §9.20.1) がコードコメントに記録されている
- SETUP 関連の参照が v22 と一致する (節番号・Figure 番号)
- 挙動変更が無いことをテストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §1.6 (Modularity) / §6.3 (Session initialization) / §6.3.2 (Extension Negotiation) / §9.1 (SETUP、Figure 3 / Figure 6) / §9.20.1 (Parameter Scope) / §16.4 (Setup Options、Table 11)
- `src/message/setup.ts` の `createSetup` / `encodeSetupPayload` / `decodeSetupPayload` / `getSetupMoqtImplementation`
- `src/message/parameter/kvp.ts` の `encodeKeyValuePairs` / `decodeKeyValuePairs`
- `src/session/connection.ts` の `connectionInitialize` / `connectionDecodeAndValidateSetup`
- `src/session/incoming.ts` の `incomingClassifyFirstBidiMessage` / `incomingHandleFirstBidiMessage` / `incomingIsRejectedNamespaceRequest` (§1.5 参照箇所)
- `src/session.ts` の制御ストリーム系フィールドの JSDoc (§1.5 参照箇所)
- `src/session/incomingPublish.ts` / `src/session/incoming.prop.ts` / `src/session/incoming.test.ts` (§1.5 参照箇所)
- `src/message/setup.test.ts` / `src/message/setup.prop.ts`

## 解決方法

{未着手}
