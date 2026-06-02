# Setup Options 用の IANA レジストリを追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7
- Polished: 2026-06-02

## 概要

draft-18 で Setup Options 用の IANA registry (§15.4) が追加され、
AUTHORITY / PATH / MAX_AUTH_TOKEN_CACHE_SIZE / AUTHORIZATION TOKEN /
MOQT IMPLEMENTATION などが登録される枠組みができた。

moqt-js の `SetupOptionType` 定数は既にこれらのオプションを定義しており、
コメントの draft 番号と節番号を更新するのみ。未知 Setup Option の
ignore 処理についても、0197 の未知値受信時のセッション維持と整合させる。

## RFC 参照

draft-ietf-moq-transport-18 §15.4 (Setup Options):

> This document establishes the "MOQT Setup Options" IANA registry.

draft-ietf-moq-transport-18 §10.3.1 (Setup Options):

> Setup Options with reserved identifiers have no semantics and can
> carry arbitrary values. Endpoints MUST ignore unknown Setup Options.

draft-ietf-moq-transport-18 A.1: "Add IANA registry for Setup Options (#1564)"

## 変更内容

1. `src/message/types.ts` の `SetupOptionType` 定数の JSDoc を draft-18 に更新し、IANA registry への参照を追加する
2. `src/message/setup.ts` の `decodeSetupPayload` の JSDoc に「未知 Setup Option は ignore」を明記する
3. 未知 Setup Option の処理が 0197 の「未知値でセッションを閉じない」と整合することを確認する

## 該当ファイル

| ファイル               | 行番号            | 変更内容                                                               |
| ---------------------- | ----------------- | ---------------------------------------------------------------------- |
| `src/message/types.ts` | (SetupOptionType) | JSDoc を draft-18 §15.4 に更新する                                     |
| `src/message/setup.ts` | 1-8               | draft 番号を 18 に更新する                                             |
| `src/message/setup.ts` | 81-142            | `decodeSetupPayload` の JSDoc に未知 Setup Option の ignore を追記する |

## 期待される動作

1. 既知の Setup Options (0x01 PATH, 0x03 AUTHORIZATION_TOKEN, 0x04 MAX_AUTH_TOKEN_CACHE_SIZE, 0x05 AUTHORITY, 0x07 MOQT_IMPLEMENTATION) は従来通り処理する
2. 未知の Setup Option Type を受信した場合、エラーにせず無視する
3. GREASE 値 (0x7f \* N + 0x9D) の Setup Options も無視する

## テスト方針

- `src/message/setup.test.ts` に未知 Setup Option を含む SETUP メッセージのデコードテストを追加する
- 未知 Setup Option が無視され、既知の Option が正しくデコードされることを検証する

## 影響範囲

- 実装変更あり (未知 Setup Option の ignore 処理)
- 後方互換あり (未知 Option をエラーにしていたのを ignore に変更)
- 0197 と強く関連 (未知値受信時のセッション維持)
