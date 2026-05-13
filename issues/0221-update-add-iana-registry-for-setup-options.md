# Setup Options 用の IANA レジストリを追加する

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で Setup Options 用の IANA registry が追加され、
AUTHORITY / PATH / MAX_AUTH_TOKEN_CACHE_SIZE / AUTHORIZATION TOKEN / MOQT IMPLEMENTATION などが
登録される枠組みができた。
moqt-js は Setup Options の定数 / 列挙を仕様の登録項目と整合させる。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.3.1 Setup Options
- draft-ietf-moq-transport-18 §15 IANA Considerations (推定)
- moq-wg/moq-transport#1564

## 影響範囲

- Setup Options 定数
- 未知 Setup Option のハンドリング (#1561 と関連)
