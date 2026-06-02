# Startup Latency と 0-RTT のガイダンスを改善する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で接続立ち上げ時のレイテンシ削減と 0-RTT 利用に関するガイダンスが拡充された。
moqt-js は WebTransport クライアントであり、0-RTT は WebTransport セッション確立時に
ブラウザが自動的に処理する。moqt-js 側で 0-RTT を直接制御する API は存在しないため、
実装変更は不要。コメントの更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §3.3.1 (0-RTT):

> The client can also use 0-RTT to send Objects before the session is
> fully established.

draft-ietf-moq-transport-18 A.1: "Improve startup latency and 0-RTT guidance (#1544)"

## 変更内容

1. `src/session.ts` の Session 確立シーケンスのコメントに 0-RTT ガイダンスへの参照を追記する

## 該当ファイル

| ファイル         | 行番号 | 変更内容                                                                 |
| ---------------- | ------ | ------------------------------------------------------------------------ |
| `src/session.ts` | 1-4    | draft 番号を 18 に更新する                                               |
| `src/session.ts` | 86-95  | `Session` インターフェースの JSDoc に 0-RTT ガイダンスへの参照を追記する |

## 期待される動作

1. WebTransport セッション確立時にブラウザが 0-RTT を処理する
2. moqt-js は 0-RTT 完了までは SETUP 送信を待つ (既存通り)
3. 実装に変更はない

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ
- 後方互換あり
