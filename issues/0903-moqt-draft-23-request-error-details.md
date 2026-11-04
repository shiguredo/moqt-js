# REQUEST_ERROR の末尾を Error Details にし REDIRECT と UNSUPPORTED_PROPERTY を扱う

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
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

- `src/message/session.ts` の REQUEST_ERROR を draft-23 §9.4 の形にした。末尾を §8.3 の KVP 列 (Error Details) として encode / decode し、`ErrorDetailType` を追加した。REDIRECT (0x01) は Length 付き Value、UNSUPPORTED_PROPERTY (0x02) は vi64 Value を持ち複数出現できる。
- Detail の扱いを §9.4.1 / §9.4.2 に合わせた。未知の Detail と適用外の既知 Detail は読み飛ばして無視し、未知型の重複は許容する。REDIRECT の欠落 (Track namespace scope) と重複は MALFORMED_MESSAGE、既知 Detail の Length / Value の不整合は MALFORMED_KEY_VALUE、Length の最大超過は FIELD_LENGTH_EXCEEDED、Type Delta の累積超過は DELTA_ENCODING_OVERFLOW とする (§12.2 の優先順位)。
- 公開 API に `RequestError.unsupportedPropertyTypes: readonly bigint[]` を追加した。コンストラクタの 5 番目の省略可能引数で既定 `[]` とし、既存利用者に対して後方互換を保つ。
- `src/properties.ts` の `decodeProperties` / `parseProperties` / `decodeImmutableProperties` が、未知の Mandatory Track Property の Type を 1 件目で打ち切らずすべて収集し、構造全体の検証を終えてから一覧付きの `MalformedTrackError` で通知するようにした。KVP の構造破損と既知 Property の不整合は従来どおり Session エラーを優先する。
- draft-23 §3.7 に従い、Mandatory Track Property の範囲に含まれる GREASE 値は未知 Mandatory として扱わないようにした。
- 受信 PUBLISH の拒否経路 (`src/session/incomingPublish.ts`) が、未対応 Mandatory Property の Type を UNSUPPORTED_PROPERTY Detail に載せて REQUEST_ERROR を送るようにした。Reason Phrase は固定の短い文言 `unsupported mandatory track properties` とし、Type の一覧は Detail だけに載せる (§8.5 の長さ上限で受信側が FIELD_LENGTH_EXCEEDED にしないため)。
- 未知 Mandatory 以外の理由で malformed になった PUBLISH は、PUBLISH への応答に使える Error Code が §12.3 に無いため、UNSUPPORTED_EXTENSION に置き換えず REQUIRE の取消しとして送受信を終了する。
- `src/session/incoming.ts` の `incomingSendRequestErrorAndClose` に `IncomingRequestErrorOptions` を追加し、Detail を載せた REQUEST_ERROR を送れるようにした。`src/session/bidi.ts` の `buildRequestErrorFromDecoded` が一覧を公開 `RequestError` へ伝搬する。
- テストは固定ワイヤ (REDIRECT / UNSUPPORTED_PROPERTY / 未知 Detail / 適用外 Detail / 未知型重複 / Detail 欠落 / Detail 重複 / 長さ不整合 / 上限超過 / delta 超過)、PBT、本番経路の PUBLISH 拒否 E2E、各応答 reader / namespace / REQUEST_UPDATE 経路への伝搬を検証する。

### 既知の制限

- Track-scoped Redirect の空 Track Name の非空検証は、非空 Track Name の issue で扱う。generic decoder は空を許容し、namespace-scoped の非空検証は維持している。
- GREASE の Error Detail を送る機構は既存に無いため送信は未実装。受信時は未登録 Type として読み飛ばすことをテストしている。
- 未対応 Mandatory 以外の malformed PUBLISH の取消しは、CANCELLED コード付き取消しを扱う issue で再検討する。
- `ErrorDetailType` は非公開のまま。UNSUPPORTED_PROPERTY の値域検証は行っていない。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。

### 残課題 (別 issue で扱う)

- Track-scoped Redirect の空 Track Name 検証 (0911)
- CANCELLED コード付き取消しと scope 違反の構造化 (0913)
- Property scope / 重複検証 (0913 / 0914)
