# Abstract と Introduction の書き直しに追随する

- Priority: Low

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で Abstract と Introduction が大幅に書き直された。
モチベーション (Latency / Leveraging QUIC / Convergence / Relays) の整理および
用語の刷新が行われている。moqt-js の実装コードへの影響はなく、
参照コメントの draft 番号更新のみ。

## RFC 参照

draft-ietf-moq-transport-18 §1 (Introduction):

> Media Over QUIC Transport (MOQT) is a publish/subscribe protocol that
> runs over QUIC or WebTransport.

draft-ietf-moq-transport-18 §1.1 (Motivation):

> The development of MOQT is driven by goals in a number of areas -
> specifically latency, the robust feature set of QUIC and relay support.

draft-ietf-moq-transport-18 A.1: "Rewrite Abstract and Introduction (#1556)"

## 変更内容

1. 全ソースファイルの draft-ietf-moq-transport-17 参照を draft-ietf-moq-transport-18 に更新する
2. 特に §1 (Introduction) を参照している箇所の節番号と文言を確認する

## 該当ファイル

| ファイル               | 行番号     | 変更内容                       |
| ---------------------- | ---------- | ------------------------------ |
| `src/session.ts`       | 1-4        | draft 番号を 18 に更新する     |
| `src/message/types.ts` | (全般)     | draft 番号を 18 に更新する     |
| `src/index.ts`         | (全般)     | draft 番号を 18 に更新する     |
| 全 `*.ts` ファイル     | コメント部 | draft-17 → draft-18 の一括更新 |

## 期待される動作

- 動作に変更はない
- 全コメントの draft 参照が draft-18 に統一される

## テスト方針

- 既存テストの変更は不要

## 影響範囲

- 実装変更なし、コメント更新のみ (ファイル数が多いが機械的な置換)
- 後方互換あり
