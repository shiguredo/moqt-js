# SETUP での拡張機能宣言の明確化に追随する

- Created: 2026-10-02
- Completed: {YYYY-MM-DD}
- Branch: feature/update-setup-extension-negotiation
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-22 §6.3.2 (Extension Negotiation) は、拡張機能のサポートを SETUP の Setup Option で宣言し、汎用の宣言形式は無く各拡張仕様が Option の型・値・交渉規則を定めると明確化した。Setup Option は IANA に登録する (§16.4)。

v21 では Extensibility の記述が §1.5 にあり、moqt-js はその節を参照している。v22 の §1.5 は Response Message Naming に変わったため、参照が誤っている。参照を更新し、SETUP の扱いが新しい記述と整合することを確認する。

## 現状

- `src/session/incoming.ts` は v21 §1.5 (Extensibility) を参照している。v22 §1.5 は Response Message Naming であり、拡張の交渉は §6.3.2
- `src/message/setup.ts` の `decodeSetupPayload` は未知の Setup Option を解釈せずパラメータ配列に保持するだけで拒否しない。`encodeSetupPayload` は対応する Option (AUTHORIZATION_TOKEN (0x03) / MAX_AUTH_TOKEN_CACHE_SIZE (0x04) / MAX_FILTER_RANGES (0x06) / MOQT_IMPLEMENTATION (0x07) / MAX_REQUEST_UPDATES (0x08) と GREASE) のみを送る
- `src/session/connection.ts` の `connectionDecodeAndValidateSetup` は受信した Option を読み、`peerMaxRequestUpdates` / `peerMaxFilterRanges` / `peerMaxAuthTokenCacheSize` を保持する
- Setup Option と Message Parameter は別のレジストリであり、SETUP に Message Parameter は出現しない (§9.20.1)

## 設計方針

- コメントの参照を §6.3.2 (Extension Negotiation) / §9.1 (SETUP) / §9.20.1 に更新する
- moqt-js が宣言する Setup Option の一覧と、拡張ごとに Option で宣言する仕組みをコメントに整理する
- 未知 Setup Option を無視する現状の挙動が §9.1 と整合することを確認する
- 将来の拡張追加時に汎用形式を仮定しないこと (拡張仕様が Option を定義する) をコメントに残す

## 完了条件

- 誤った §1.5 Extensibility 参照が無くなり、§6.3.2 / §9.1 を指している
- 未知 Setup Option の扱いの確認結果が記録されている
- 挙動変更が無いことをテストで確認する
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-22 §6.3.2 (Extension Negotiation) / §9.1 (SETUP) / §16.4 (Setup Options)
- `src/message/setup.ts` の `decodeSetupPayload` / `encodeSetupPayload` / `getSetupMoqtImplementation`
- `src/session/connection.ts` の `connectionDecodeAndValidateSetup`
- `src/session/incoming.ts` の §1.5 参照箇所

## 解決方法

{未着手}
