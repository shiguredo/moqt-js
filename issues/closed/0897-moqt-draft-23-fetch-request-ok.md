# FETCH_OK を REQUEST_OK に統合し終端を要求範囲と LARGEST_OBJECT から求める

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §3.2 / §9.3 は FETCH 成功応答を REQUEST_OK (0x07) に統合し、専用の FETCH_OK (0x18)、End Of Track、End Location を削除した。現在の fetch は正常な draft 23 応答を受理できない。

## 現状

- `src/message/fetch.ts` の `FetchOk` / `decodeFetchOkPayload` は End Of Track と End Location を必須とする
- `src/session/bidi.ts` の `bidiReadFetchResponse` は `MessageType.FETCH_OK` を待ち、専用 decoder と `validateFetchOkEndLocation` を使う
- `src/message/parameterScope.ts` の `FETCH_OK_ALLOWED_PARAMS` は空である
- `src/fetcher.ts` の `setFetchOkInfo` と公開 getter は旧フィールドに依存する。`buildFetchParameters` は相対 Location Filter も送れる

## 設計方針

- FETCH の応答を REQUEST_OK として decode し、EXPIRES / LARGEST_OBJECT と Track Properties を受け取る。旧 0x18 は予約値として扱う
- 終端は FETCH の要求 End Location と、応答に存在する LARGEST_OBJECT から §3.2 に従って応答受理時に確定する。Largest Object が要求範囲内ならその位置、範囲外なら要求 End を使う。None / 終端なしの要求では LARGEST_OBJECT が必要になる。Largest Object が「到着中」である意味を保つ
- `Fetcher.endLocation: Location` は応答がカバーする範囲の inclusive な上限とする。Type 0x03 で LARGEST_OBJECT による終端が得られない場合は `{ group: StartGroup + EndGroupDelta, object: 2^64-1 }` に正規化する。この Object ID は Group 全体を含む境界値であり、実在する最後の Object ID だとは説明しない。後続データの最後の実 Object に合わせて書き換えない
- `Fetcher.endOfTrack` は「Track 終端を確認済み」の boolean とし、応答受理時は false とする。false は Track が今後も続くことを保証しない。0900 で End of Track indicator を処理した時に true に更新し、単なる FETCH FIN では変更しない。応答から削除された End Of Track を仮定しない
- 相対 Location Filter (Type 0x01) の FETCH は §3.2 で INVALID_RANGE になったため、公開送信 API では副作用前に拒否する。Type 0x05 (Next Object) も既存 Object の範囲にならないため拒否する。None と絶対指定を扱い、この制約を共用 codec や fill 内側に適用しない。fill の相対指定は §3.4 / §3.5 が引き続き使う
- fill fetch は REQUEST_OK の FETCH 応答を持たない別経路であるため、初期購読の LARGEST_OBJECT からの範囲解決を混同しない

## 完了条件

- REQUEST_OK 成功、旧 0x18、EXPIRES / LARGEST_OBJECT、Track Properties と未知 Mandatory Property を検証する
- 終端が要求内 / 要求外 / 未指定のケース、1 Object の範囲、到着中の Largest Object を検証する
- 相対指定の送信拒否と絶対指定の受理を検証する
- Type 0x03 と LARGEST_OBJECT 省略の成功応答で Group 上限の endLocation が得られ、実 Object の最終位置と混同されない
- Fetcher の公開型と API 文書が削除済みフィールドを必須とせず、endLocation の境界値と endOfTrack の確認時点を説明する

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.2 / §9 / §9.3 / §9.11 / §9.19.9 / §9.19.17
- `src/message/fetch.ts`、`src/session/requests.ts`、`src/session/bidi.ts`、`src/session/params.ts`、`src/fetcher.ts`
- 0900 は FETCH の終端 indicator、0909 は全 OK の EXPIRES の扱いを担当する

## 解決方法

- FETCH の成功応答を REQUEST_OK (0x07) として受理するように変更した。`MessageType.FETCH_OK` (0x18) を削除して予約値として扱い、FETCH 応答の読み取り経路 (`bidiReadFetchResponse`) の `okType` を REQUEST_OK にした。REQUEST_OK は PUBLISH / TRACK_STATUS などでも使われるが、保留中のリクエスト種別ごとに読み取り経路が分かれているため混同しない。旧 0x18 は未知のメッセージ型として扱い、セッションを閉じる (現行のエラー分類では PROTOCOL_VIOLATION、UNEXPECTED_MESSAGE への移行は別途対応する)。既知の別メッセージ型が応答として届いた場合は §6.6 の裁量に従いリクエスト単位の失敗とし、セッションは閉じない。
- `FetchOk` / `encodeFetchOkPayload` / `decodeFetchOkPayload` を削除し、`FETCH_OK_ALLOWED_PARAMS` を EXPIRES / LARGEST_OBJECT にした。Track Properties と未知 Mandatory Track Property の扱いは従来どおり維持する。
- 応答がカバーする範囲の終端を、要求範囲と応答の LARGEST_OBJECT から受理時に確定する純粋関数 (`resolveFetchRequestRange` / `resolveFetchResponseEndLocation`) を追加した。要求範囲内なら LARGEST_OBJECT、要求 End より後なら要求 End、閉端で LARGEST_OBJECT を欠く場合は要求 End、開端で LARGEST_OBJECT を欠く場合はプロトコル違反、LARGEST_OBJECT が要求 Start より前の場合は開端・閉端ともプロトコル違反とする。Type 0x03 で終端が得られない場合は `{StartGroup + EndGroupDelta, 2^64-1}` に正規化し、この Object ID を実在する最後の Object ID として扱わない。
- `Fetcher.endLocation` は inclusive な上限、`Fetcher.endOfTrack` は応答受理時 false (End of Track indicator の処理は別途対応) とし、公開 JSDoc と API 文書を更新した。要求範囲は `setFetchRequestRange` / `getFetchRequestRange` の 1 組で保持し、Start と End の不整合状態を作らせない。
- FETCH の Location Filter は相対指定 (0x01) と Next Object (0x05) を送信前に拒否するようにした。相対指定は §3.2 が INVALID_RANGE と定め、Next Object は Largest Object + 1 を指して既存 Object の範囲にならないためである。同一 Group で End Object が Start Object より小さい空範囲も拒否する。これらの検証は Request ID 消費などの副作用より前に行い、共通 codec と FILL_PARAMETERS 内側の相対指定には適用しない。
- `InvalidFilterError` をパッケージルートから export し、クラス JSDoc に fetch() の拒否条件を追記した。
- テストは REQUEST_OK 成功、旧 0x18 の拒否とセッション終了、既知の別メッセージ型のリクエスト失敗、EXPIRES / LARGEST_OBJECT / Track Properties、要求内 / 要求 End より後 / 要求 Start より前 / 1 Object / 0x03 の正規化 / 到着中の LARGEST_OBJECT、相対・Next Object・空範囲の送信前拒否、Fetcher の公開型と要求範囲、FETCH_OK 許可集合を検証する。PBT では要求範囲と応答終端の確定、相対・Next Object・空範囲の拒否を検証する。

### 既知の制限

- `Fetcher.endOfTrack` は End of Track indicator の処理を追加するまで常に false である (公開 JSDoc と API 文書に明記)。
- draft-23 の UNEXPECTED_MESSAGE / MALFORMED_MESSAGE / INVALID_PARAMETER へのエラー分類移行は別途対応する。現行の受信経路は PROTOCOL_VIOLATION として扱う。
- 統合ブランチのため ALPN は moqt-22 のままで、REQUEST_OK 統合の実リレー相互接続は移行完了後に確認する。
- README / docs の draft-22 参照の一括更新は移行全体の仕上げで行う (今回触れた箇所は draft-23 に更新済み)。

### 残課題 (別 issue で扱う)

- FETCH の End of Range / End of Group / End of Track indicator (0898 / 0899 / 0900)
- 全 OK 応答の EXPIRES (0909)
- セッションエラー分類の移行 (0902)
