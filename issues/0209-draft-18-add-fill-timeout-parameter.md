# FILL_TIMEOUT パラメータを追加する

- Priority: Medium

Created: 2026-05-13
Model: Opus 4.7

- Polished: 2026-06-02

## 概要

draft-18 で新しいパラメータ FILL_TIMEOUT (Parameter Type 0x0A) が追加された。
relay が欠損 object の fill 待機に費やす最大時間を制御する。
moqt-js は Subscriber 側で FETCH 送信時にこのパラメータを指定できるようにする。

## RFC 参照

draft-ietf-moq-transport-18 §10.2.5 (FILL TIMEOUT Parameter):

> The FILL_TIMEOUT parameter (Parameter Type 0x0A) MAY appear in a
> FETCH message.
>
> It is the maximum total duration in milliseconds a relay SHOULD spend
> waiting for upstream sources to provide Objects that are not
> immediately available before reporting them as Unknown gaps in the
> FETCH response.
>
> A value of 0 indicates the subscriber only wants Objects that are
> immediately available; the relay MUST NOT wait for upstream delivery
> and MUST report any unavailable Objects as Unknown gaps.

draft-ietf-moq-transport-18 A.1: (この追加は §10.2.5 に含まれる)

## 変更内容

1. `src/message/parameter.ts` に `MessageParameterType.FILL_TIMEOUT = 0x0A` を追加する
2. `src/message/parameter.ts` のパラメータエンコード/デコードに FILL_TIMEOUT (varint 値) の処理を追加する
3. `src/session.ts` の `FetchOptions` に `fillTimeout?: bigint` を追加する
4. `src/session.ts` の `fetch()` メソッドで FILL_TIMEOUT パラメータを FETCH メッセージに含める
5. `src/index.ts` から `fillTimeout` オプションを公開する

## 該当ファイル

| ファイル                   | 行番号    | 変更内容                                                            |
| -------------------------- | --------- | ------------------------------------------------------------------- |
| `src/message/parameter.ts` | (全般)    | `FILL_TIMEOUT = 0x0A` パラメータ定数とエンコード/デコードを追加する |
| `src/session.ts`           | 451-460   | `FetchOptions` に `fillTimeout?: bigint` を追加する                 |
| `src/session.ts`           | 1278-1358 | `fetch()` のパラメータ構築に FILL_TIMEOUT を含める                  |
| `src/session.ts`           | 2090-2140 | `sendJoiningFetch` にも FILL_TIMEOUT オプションを適用する           |
| `src/index.ts`             | (全般)    | `fillTimeout` を公開する                                            |

## 期待される動作

1. Standalone FETCH 送信時に `fillTimeout` を指定できる
2. Joining Fetch 送信時にも `fillTimeout` を指定できる
3. `fillTimeout = 0n` を指定すると即時応答を要求する (relay は fill 待機しない)
4. FILL_TIMEOUT パラメータを受信した場合、無視して良い

## テスト方針

- `src/message/parameter.test.ts` に FILL_TIMEOUT パラメータのエンコード/デコードテストを追加する
- `src/message/parameter.prop.ts` のラウンドトリップ PBT に新パラメータを追加する
- `src/message/fetch.prop.ts` の FETCH メッセージ PBT に FILL_TIMEOUT パラメータを含める

## 影響範囲

- 実装変更あり
- 後方互換あり (新規パラメータの追加。指定しない場合はパラメータ自体が送信されない)
- devtools の Fetch パネルに FILL_TIMEOUT 入力欄を追加するのが望ましい
- `CHANGES.md` に [ADD] エントリを追加する
