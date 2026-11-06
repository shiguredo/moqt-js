# セッション終了コードを draft 23 の具体的なエラー分類に移行する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §12.2 は PROTOCOL_VIOLATION を残しつつ、データ・制御・共通の具体的コードを追加した。現在の例外変換は多くの不正入力を一律 0x03 にし、peer から届いた新コードも INTERNAL_ERROR に正規化する。

## 現状

- `src/error.ts` の `SessionErrorCode` に 0x200〜0x401 の新コードが無く、0x06 は旧名 KEY_VALUE_FORMATTING_ERROR である
- `src/session/errors.ts` の `toSessionCloseError` などは `ProtocolViolationError` / `IncompleteDataError` を汎用コードへ変換する
- `src/properties.ts`、`src/message/parameter/*`、`src/dataStream/*` と受信ループに旧コードの明示指定がある

## 設計方針

- 0x06 を MALFORMED_KEY_VALUE に改名し、次の分類を定義・伝搬する

| コード                        | 主な条件                                                 |
| ----------------------------- | -------------------------------------------------------- |
| INVALID_STREAM_HEADER 0x200   | 未知のデータ stream / datagram 型、予約された Type Flags |
| MALFORMED_OBJECT 0x201        | Object の構造不正、先行 Object の無い継承参照            |
| INVALID_OBJECT_STATUS 0x202   | 不正 Status、非 Normal Object の Properties              |
| TRUNCATED_OBJECT 0x203        | Object の途中で FIN                                      |
| MALFORMED_MESSAGE 0x300       | 制御メッセージの構造・長さ不一致、必須要素欠落           |
| INVALID_FIELD 0x301           | parse 済みの禁止フィールド値                             |
| INVALID_TRACK_NAMESPACE 0x302 | 空の namespace field、field 数超過                       |
| UNEXPECTED_MESSAGE 0x303      | 未知・誤順序・誤 stream・重複メッセージ                  |
| ROLE_VIOLATION 0x304          | 役割上送信できないメッセージやフィールド                 |
| INVALID_PARAMETER 0x305       | 未知・禁止・重複・値域外の Message Parameter             |
| CLOSED_CONTROL_STREAM 0x306   | peer が制御ストリームを閉じる                            |
| DELTA_ENCODING_OVERFLOW 0x400 | delta 復元結果の負数・64 bit 上限超過                    |
| FIELD_LENGTH_EXCEEDED 0x401   | フィールド・構造の最大長超過                             |

- 既知の Setup Option / Property の Value / Length が Type の定義する serialization に一致しない場合は、§8.3 に従い MALFORMED_KEY_VALUE とする。外側から切り出した Token 構造自体が decode できない場合は、未知 Alias Type を含めて §8.9 の MALFORMED_AUTH_TOKEN とする。Message Parameter は KVP ではないため、AUTHORIZATION_TOKEN パラメータの外側構造の破損まで MALFORMED_KEY_VALUE にまとめず、制御本文の構造不正として分類する
- DELTA_ENCODING_OVERFLOW / FIELD_LENGTH_EXCEEDED を他の該当コードより優先する。受信途中のデータ不足は直ちにエラーにせず、完全な制御本文の decode 不足や FIN 時に文脈を確定させる
- 新コードを normalizer / デバッグ表示 / 公開型に反映する。未知コードの §13 の扱いは維持し、範囲によるカテゴリ識別を認証や回復の意味に置き換えない
- 空 Track Name と要求受信者への GOAWAY は、§2.4.1 / §9.2 が明示する PROTOCOL_VIOLATION を維持する。文字列置換で全例外を一括変更しない
- 他の draft 23 issue で追加する検証も同じ例外体系を使う。Track の malformed に対する request / stream 単位の終了を Session 終了へ変えない

## 完了条件

- 新コードを受信しても既知コードとして保持し、廃止名が公開 API に残らない
- 各分類に実入力からの到達テストがあり、数値定数だけを検証して終わらない
- Session 制御、要求応答、namespace、Datagram、Subgroup、FETCH の全受信経路で理由に対応するコードになる
- 長さ / delta の優先順位と、MalformedTrackError をセッション終了にしない境界を検証する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §6.3 / §8.3〜§8.9 / §9 / §10.4〜§10.6 / §11 / §12.2 / §13
- `src/error.ts`、`src/session/errors.ts`、`src/session/lifecycle.ts`、`src/properties.ts`、`src/message/parameterScope.ts`
- REQUEST_ERROR / PUBLISH_DONE / reset の登録値変更は 0915 が担当する

## 解決方法

- `src/error.ts` の `SessionErrorCode` に draft-23 §12.2 のデータ・制御・共通コードを追加し、0x06 を MALFORMED_KEY_VALUE に改名した。追加したのは INVALID_STREAM_HEADER (0x200) / MALFORMED_OBJECT (0x201) / INVALID_OBJECT_STATUS (0x202) / TRUNCATED_OBJECT (0x203) / MALFORMED_MESSAGE (0x300) / INVALID_FIELD (0x301) / INVALID_TRACK_NAMESPACE (0x302) / UNEXPECTED_MESSAGE (0x303) / ROLE_VIOLATION (0x304) / INVALID_PARAMETER (0x305) / CLOSED_CONTROL_STREAM (0x306) / DELTA_ENCODING_OVERFLOW (0x400) / FIELD_LENGTH_EXCEEDED (0x401)。
- `ProtocolViolationError` に SessionErrorCode を持たせ、受信ループがそれをそのまま `SessionError` へ変換する経路を通すようにした。normalizer / デバッグ表示 / 公開型にも新コードを反映し、未知コードは従来どおり INTERNAL_ERROR として扱う (§13)。範囲からカテゴリを識別して認証や回復の意味に置き換える処理は追加していない。
- 各受信経路へ理由に対応するコードを割り当てた。Session 制御 (制御ストリーム閉鎖 CLOSED_CONTROL_STREAM、重複 GOAWAY・未知メッセージ UNEXPECTED_MESSAGE、空必須 Track Properties INVALID_FIELD、ロール別 ROLE_VIOLATION)、要求応答 (本文長不一致 MALFORMED_MESSAGE、禁止フィールド INVALID_FIELD、Parameter の未知・重複・スコープ違反・値域外 INVALID_PARAMETER、Token 構造破損 MALFORMED_AUTH_TOKEN、Setup Option の既知型 serialization 不一致 MALFORMED_KEY_VALUE)、Datagram / Subgroup (INVALID_STREAM_HEADER / MALFORMED_OBJECT / INVALID_OBJECT_STATUS / TRUNCATED_OBJECT / FIELD_LENGTH_EXCEEDED / DELTA_ENCODING_OVERFLOW)、FETCH (MALFORMED_OBJECT / DELTA_ENCODING_OVERFLOW / INVALID_STREAM_HEADER)。
- draft-23 §12.2 の優先順位に従い、DELTA_ENCODING_OVERFLOW / FIELD_LENGTH_EXCEEDED を他の該当コードより先に判定するようにした。Property / 構造の最大長超過は、既知 Type の serialization 不一致や残量不足より先に FIELD_LENGTH_EXCEEDED とする。Message Parameter の Type Delta 累積超過と Object の ID 復元超過は DELTA_ENCODING_OVERFLOW とする。
- 受信途中のデータ不足は直ちにエラーにしない。制御メッセージは完全な本文だけを渡す既存の ControlStreamReader の契約を維持し、データストリームはヘッダー不足を継続、Object 途中の FIN だけを TRUNCATED_OBJECT とする。
- 空 Track Name と要求受信者への GOAWAY は §2.4.1 / §9.2 が明示する PROTOCOL_VIOLATION を維持した。SETUP の Authorization Token DELETE / USE_ALIAS は §9.1.4 の server 宛 MUST を踏まえ、client 側の防御的検査として ROLE_VIOLATION を使う (コメントに根拠を明記)。
- `MalformedTrackError` は Track 単位の終了 (`cancelMalformedTrackPeers`) のままとし、セッション終了へ変換しない境界を維持した。
- LOC の Property 値デコーダは KVP の Value / Length 不整合として MALFORMED_KEY_VALUE を返すようにした。Object Payload 自体のデコードだけ MALFORMED_OBJECT を維持し、Property ID の不一致はデコーダ契約の誤用としてセッションコードを付けない汎用 Error とした。
- テストは各分類について実入力のワイヤ / 実ストリームから到達させ、`SessionErrorCode` を検証する。FETCH データストリームは計算 Object ID の上限超過・End of Range の ID 復元超過・未定義の 128 以上の flags・先行 Object の無い End of Group・先頭 Object の SUBGROUP_SAME 参照の 5 系統でコードを固定した。

### 既知の制限

- draft-23 の Error Code の登録は §16.12 にあり、§12 は Error Handling である。コード値の引用は §12.2 の範囲記述と §16.12 の登録に合わせている。
- 宣言長が上限を超え、かつ本文も不足する Track Namespace / Track Name は、経路によって MALFORMED_MESSAGE と FIELD_LENGTH_EXCEEDED のどちらが先になるかが異なる。Property 側は最大長超過を優先する方針に統一したが、メッセージ本文側は §9 の本文長不一致を優先する既存挙動を維持している。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施であり、新コードのワイヤ上の相互運用は未検証である。

### 残課題 (別 issue で扱う)

- REQUEST_ERROR の Error Details (0903)
- NAMESPACE の Parameters (0904)
- 要求受信者への GOAWAY 拒否 (0910)
- REQUEST_DONE / reset のコード (0915)
