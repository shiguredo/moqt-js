# REQUEST_ERROR の末尾を Error Details にし REDIRECT と UNSUPPORTED_PROPERTY を扱う

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-request-error-details
- Polished: 2026-11-03

## 目的

draft 23 §9.4 は REQUEST_ERROR の末尾を汎用の Error Details KVP 列へ変更した。REDIRECT は Type 0x01 の Detail に移り、未対応 Mandatory Property を示す Type 0x02 も追加された。現在は REDIRECT 専用構造と解釈するため、新形式と未知 Detail を受理できない。

## 現状

- `src/message/session.ts` の `encodeRequestErrorPayload` / `decodeRequestErrorPayload` は Error Reason の後に裸の Redirect を置く
- REDIRECT 以外で末尾バイトがあると拒否し、Redirect の後の追加データも拒否する
- `src/error.ts` の `RequestError` は `redirect` だけを持つ
- `src/session/incomingPublish.ts` の Mandatory Property 拒否は UNSUPPORTED_EXTENSION の理由文字列だけで、Property Type を構造化して渡せない

## 設計方針

- 末尾を §8.3 の KVP 列として Message Length まで読む。Message Parameters と別の型空間・処理規則にする
- REDIRECT (0x01) は Length 付きで既存 Redirect 情報を包む。REDIRECT エラーに該当 Detail が無ければ MALFORMED_MESSAGE とする。namespace-scoped Redirect の空 Track Name は引き続き許容し、通常 Track Name の非空検証と分ける
- UNSUPPORTED_PROPERTY (0x02) は Mandatory Track Property の Type を vi64 で保持し、UNSUPPORTED_EXTENSION に複数出現できるようにする
- 未知 Detail と、既知でも当該 Error Code に適用されない Detail は無視する。未知 Detail の重複を拒否しない。既知 Detail の反復可否は定義に従う
- 公開 RequestError へ必要な構造情報を渡す。受信 PUBLISH の未対応 Mandatory Track Property による拒否では、§9.4.2.2 の SHOULD を採用し、未対応の各 Type を実際の REQUEST_ERROR の UNSUPPORTED_PROPERTY Detail に載せる
- `src/properties.ts` の `decodeProperties` 系で、未知 Mandatory Track Property の Type を 1 件目で打ち切らず収集し、構造全体の検証後に Type 一覧を持つエラーで通知する。`MalformedTrackError` の構造情報から `src/session/incomingPublish.ts`、`incomingSendRequestErrorAndClose`、REQUEST_ERROR encoder まで一覧を引き渡す。理由文字列から Type を解析しない。SUBSCRIBE_OK / FETCH_OK などの既存の Track 取消しは保ち、構造破損や既知 KVP 不整合を UNSUPPORTED_EXTENSION に置き換えない
- Error Detail に GREASE を送る場合もこの名前空間の規則を使う。Privacy Pass の未割当 AUTH CHALLENGE 番号を推測で実装しない

## 完了条件

- 新しい REDIRECT の固定ワイヤ、Detail 欠落、未知 Detail、適用外の既知 Detail、未知型の重複を検証する
- UNSUPPORTED_PROPERTY の複数出現と公開エラーへの伝搬を検証する
- 受信 PUBLISH に複数の未対応 Mandatory Track Property がある場合、本番の拒否経路が各 Type の Detail を含む REQUEST_ERROR を送ることを検証する
- subscribe / publish / fetch / trackStatus / namespace / 更新の共通 REQUEST_ERROR 経路が新形式になる
- トークンそのものを Error Detail やテストログに出さない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.7 / §8.3 / §9.4 / §13 / §16.11
- `src/message/session.ts`、`src/error.ts`、`src/session/bidi.ts` の `buildRequestErrorFromDecoded`、`src/session/namespaceLoops.ts` の `decodeRequestErrorToRequestError`
- `src/session/incomingPublish.ts`、`src/session/incoming.ts` の `incomingSendRequestErrorAndClose`
- `src/properties.ts` の `decodeProperties` 系、`src/error.ts` の `MalformedTrackError`

## 解決方法

{未着手}
