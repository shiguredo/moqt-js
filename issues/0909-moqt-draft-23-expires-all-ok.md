# EXPIRES を TRACK_STATUS_OK を含むすべての OK で受理する

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-expires-all-ok
- Polished: 2026-11-03

## 目的

draft 23 §9.3 / §9.19.16 は EXPIRES を任意の REQUEST_OK に許可し、TRACK_STATUS_OK では同じ Track の SUBSCRIBE_OK に入れる値を表すと明示した。移行中の OK の許可集合を一貫させる必要がある。

## 現状

- `src/message/parameterScope.ts` の `TRACK_STATUS_OK_ALLOWED_PARAMS` は LARGEST_OBJECT のみであり、コメントで EXPIRES を意図的に拒否すると説明している
- `FETCH_OK_ALLOWED_PARAMS` も空で、その他の OK は既に EXPIRES を受理する
- `src/session/bidi.ts` の `bidiReadTrackStatusResponse` は上記集合を使うため、正常な新しい応答で Session を閉じる

## 設計方針

- TRACK_STATUS_OK に EXPIRES を許可し、旧版の不整合を根拠にした拒否方針を置き換える
- FETCH_OK の REQUEST_OK 化と EXPIRES の読み取りは 0897 が担当する。本 issue は残る OK 文脈と期限の説明を監査する
- EXPIRES は購読だけでなく request の終了時期の通知とする。0 / 省略は期限不明または期限無し、値は advisory であり、自動取消しや自動再認証の必須機構にしない
- TRACK_STATUS_OK の EXPIRES を TRACK_STATUS 自体の存続期限と誤解しない

## 完了条件

- TRACK_STATUS_OK の EXPIRES + LARGEST_OBJECT が受理される
- FETCH を含む各 OK の許可集合が §9.3 と一致し、禁止パラメータまで受理しない
- 期限の 0 / 省略 / 正値と、公開 API で返す値の意味がテスト・文書で明確になる

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §9.3 / §9.12 / §9.19.16
- `src/message/parameterScope.ts`、`src/session/bidi.ts` の `bidiReadTrackStatusResponse`、`src/session/publicTypes.ts` の `TrackStatusResult`

## 解決方法

{未着手}
