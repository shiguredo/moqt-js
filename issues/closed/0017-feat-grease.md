# Setup Options/Properties/エラーコードの GREASE

## 概要

Setup Options、Properties、エラーコードのレジストリに GREASE (Generate Random Extensions And Sustain Extensibility) を追加する。

## 参照

- draft-ietf-moq-transport-17 Section 14
- https://github.com/moq-wg/moq-transport/pull/1460

## 変更内容

- draft-17 で GREASE メカニズムが追加された
- Setup Options、Properties、エラーコードの各レジストリに GREASE 用の予約値が定義される
- エンドポイントは未知の GREASE 値を無視しなければならない
- 相互運用性の確保と拡張性の維持が目的

## 影響範囲

- `src/message/setup.ts`
- `src/extensions.ts`
- `src/error.ts`
- `src/session.ts`

## 実装方針

1. draft-17 Section 14 の GREASE 仕様を確認する
2. GREASE 値の生成・送信処理を実装する
3. 受信時に未知の GREASE 値を無視する処理を確認する
4. テストを追加する

## 解決方法

`src/grease.ts` に GREASE 値の判定関数 (`isGreaseValue`) と生成関数 (`generateGreaseValue`) を実装した。GREASE 値のパターンは `0x7f * N + 0x9D` (N は非負整数)。受信側の未知値無視は既存実装でサポート済み (Setup Options は未知パラメータを無視、Properties は `unknownProperties` に保持)。GREASE 値の積極的送信は呼び出し側に委ねる。
