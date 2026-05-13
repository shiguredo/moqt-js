# object を持たない track への FETCH は INVALID_RANGE を返す

Created: 2026-05-13
Model: Opus 4.7

## 概要

draft-18 で「object を 1 つも持たない track への FETCH は INVALID_RANGE エラーを返す」と明示された。
moqt-js は Subscriber 側で INVALID_RANGE 応答の取り扱いを確認し、
INVALID_RANGE がアプリケーション層に分かりやすく伝わるようにする。

## draft-18 参照

- draft-ietf-moq-transport-18 §10.12 FETCH
- draft-ietf-moq-transport-18 §10.12.3 Fetch Handling
- moq-wg/moq-transport#1537

## 影響範囲

- FETCH 応答 (REQUEST_ERROR INVALID_RANGE) ハンドリング
- Joining Fetch のエラー伝搬
- 関連テスト (既に 0133 で部分対応済みの可能性あり、要確認)
