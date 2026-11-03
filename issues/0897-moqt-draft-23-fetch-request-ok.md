# FETCH_OK を REQUEST_OK に統合し終端を要求範囲と LARGEST_OBJECT から求める

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-fetch-request-ok
- Polished: {YYYY-MM-DD}

## 目的

draft 23 §3.2 / §9.3 は FETCH 成功応答を REQUEST_OK (0x07) に統合し、専用の FETCH_OK (0x18)、End Of Track、End Location を削除した。現在の fetch は正常な draft 23 応答を受理できない。

## 現状

- `src/message/fetch.ts` の `FetchOk` / `decodeFetchOkPayload` は End Of Track と End Location を必須とする
- `src/session/bidi.ts` の `bidiReadFetchResponse` は `MessageType.FETCH_OK` を待ち、専用 decoder と `validateFetchOkEndLocation` を使う
- `src/message/parameterScope.ts` の `FETCH_OK_ALLOWED_PARAMS` は空である
- `src/fetcher.ts` の `setFetchOkInfo` と公開 getter は旧フィールドに依存する。`buildFetchParameters` は相対 Location Filter も送れる

## 設計方針

- FETCH の応答を REQUEST_OK として decode し、EXPIRES / LARGEST_OBJECT と Track Properties を受け取る。旧 0x18 は予約値として扱う
- 終端は FETCH の要求 End Location と、応答に存在する LARGEST_OBJECT から §3.2 に従って確定する。要求に上限が無い場合も扱い、Largest Object が「到着中」である意味を保つ
- 応答から削除された End Of Track を仮定しない。0900 の End of Track indicator と接続し、Fetcher の公開情報をいつ確定できるか定義する
- 相対 Location Filter (Type 0x01) の FETCH は §3.2 で INVALID_RANGE になったため、公開送信 API では副作用前に拒否する。Type 0x05 (Next Object) も既存 Object の範囲にならないため拒否する。None と絶対指定を扱い、この制約を共用 codec や fill 内側に適用しない。fill の相対指定は §3.4 / §3.5 が引き続き使う
- fill fetch は REQUEST_OK の FETCH 応答を持たない別経路であるため、初期購読の LARGEST_OBJECT からの範囲解決を混同しない

## 完了条件

- REQUEST_OK 成功、旧 0x18、EXPIRES / LARGEST_OBJECT、Track Properties と未知 Mandatory Property を検証する
- 終端が要求内 / 要求外 / 未指定のケース、1 Object の範囲、到着中の Largest Object を検証する
- 相対指定の送信拒否と絶対指定の受理を検証する
- Fetcher の公開型と API 文書が削除済みフィールドを必須としない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.2 / §9 / §9.3 / §9.11 / §9.19.9 / §9.19.17
- `src/message/fetch.ts`、`src/session/requests.ts`、`src/session/bidi.ts`、`src/session/params.ts`、`src/fetcher.ts`
- 0900 は FETCH の終端 indicator、0909 は全 OK の EXPIRES の扱いを担当する

## 解決方法

{未着手}
