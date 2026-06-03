# goawayCallback の設定経路を簡略化する

- Priority: Medium
- Created: 2026-06-03
- Model: deepseek-v4-pro
- Branch: feature/draft-18

## 目的

goawayCallback の設定が session.ts → pending Map → bidi.ts → impl の 3 段階の間接参照になっている。これを簡略化し保守性を向上させる。

## 優先度根拠

3 段階の間接参照は意図の追跡を著しく困難にし、バグの温床になる。新しいリクエスト種別追加時のパターン漏れリスクが高い。

## 現状

1. `src/session.ts:1255`: `pendingPublish` Map に `goawayCallback: callbacks?.goaway` を格納
2. `src/session/bidi.ts:271`: `pending.impl.goawayCallback = pending.goawayCallback` で impl に転送
3. `src/session/bidi.ts:672`: `publisher.goawayCallback?.(decoded.newSessionUri)` で読み出し

同様のパターンが subscribe (bidi.ts:346) と fetch (bidi.ts:471) にも存在。

## 設計方針

- コンストラクタで直接 impl に `goawayCallback` を設定する方式に変更する
- または pending Map から直接 `goawayCallback` を呼ぶ方式に変更する
- 最低限、中間転送の意図をコメントで明示する

## 完了条件

- goawayCallback の設定経路が 2 段階以下になっている
- 全リクエスト種別で一貫した設定方法が使われている
