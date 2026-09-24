# cancelStreamQuiet が打ち切りの理由コードを wire に載せられない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/bug-cancel-stream-quiet-error-code
- Polished: 2026-09-24

## 目的

closed の `0646-bug-data-stream-buffer-limit.md` で、上限を超えた受信データストリームを `cancelStreamQuiet` で打ち切る実装を入れた。この経路は文字列 reason しか渡せないため、draft-ietf-moq-transport-21 §12.5 の「reset / STOP_SENDING には relevant なコードを使う SHOULD」を wire 上で満たせない。ピアは打ち切りの理由 (過負荷 / malformed track) をコードで判別できない。同じ制約は 0646 が入れた上限超過だけでなく、malformed track の打ち切りと fill / pending mode の打ち切りにもあり、コードを reason 文字列へ埋め込む経路と埋め込まない経路が混在している。0646 の「残した課題」にも同じ制約が記録されている。

## 現状

- `src/session/stream.ts` の `cancelStreamQuiet` (382-391 行目) は `reader.cancel(reason)` を呼ぶ。引数は `reason: string` だけで、HTTP/3 の application error code を指定する手段が無い (WebTransport の `ReadableStream` の cancel は任意の JS 値を理由として受け取るだけである)
- この制約と「reason 文字列へコードを埋め込む」回避策は `src/session/dataStreamIncoming.ts` の `dataStreamBufferOverflowReason` の JSDoc (1145-1150 行目) に書かれている
- コードを埋め込む経路は 2 つある。`dataStreamBufferOverflowReason` (1151-1156 行目) は `code=${DataStreamErrorCode.EXCESSIVE_LOAD}` を含む文字列を返し、`dataStreamHandleMalformedFetchTrack` (608-628 行目) は 614-617 行目で `code=${DataStreamErrorCode.MALFORMED_TRACK}` を渡す
- コードを埋め込まない経路は 4 種類ある。`dataStreamHandleMalformedSubgroupTrack` (831-849 行目) は 845-848 行目で同じ malformed 打ち切りでありながら `code=` を含めない。fill の malformed (557-560 行目)、pending mode の abandon (922-925 行目 / 938-941 行目 / 954-957 行目の 3 か所)、`src/session/namespaceLoops.ts` の 304 行目も含めない
- 受信側は逆にコードを読める。`src/session/bidi.ts` の `createResetStreamErrorWithMessage` (4470-4483 行目) が読み取り失敗値の `streamErrorCode` を取り出し、`normalizeDataStreamErrorCode` (4478 行目) で正規化してアプリへ渡す。`src/error.ts` の `DataStreamErrorCode` (154-165 行目) に `EXCESSIVE_LOAD` (0x9、163 行目) と `MALFORMED_TRACK` (0x12、164 行目) は定義済みである
- 送信方向も同じ制約を持つ。`WritableStreamDefaultWriter.abort(reason)` へ渡しているのは全て文字列である (`src/session/bidi.ts` の 510 / 809 / 1594 / 3970 / 4053 行目、`src/session/publish.ts` の 216 / 240 / 383 / 506 / 527 行目、`src/session/namespaces.ts` の 604 / 626 行目)
- draft-ietf-moq-transport-21 §12.5 は「The application SHOULD use a relevant error code when resetting or sending STOP_SENDING on any stream.」と定める (`refs/moq/draft-ietf-moq-transport-21.txt` の 6677-6678 行目)
- `src/session.test.ts` の「Subgroup データストリーム: バッファ上限を超えると打ち切られ購読が closed になる」(6291 行目) は、cancel の reason に `code=9` が含まれることを現在の契約として固定している (6355 行目)
- 0646 の「残した課題」に「`cancelStreamQuiet` の reason は wire のエラーコードを送れないため、§12.5 の『reset / STOP_SENDING には relevant なコードを使う SHOULD』は wire 上では満たせない」と記録されている

## 設計方針

- `cancelStreamQuiet` の引数を `(reader, reason, options?: { errorCode?: DataStreamErrorCode })` に変え、理由コードを型で渡せる API にする。全呼び出し元が「コード有り / コード無し」を明示する形にし、reason 文字列へ埋め込むかどうかを呼び出し側の判断に委ねない
- reason 文字列の組み立ては `formatStreamAbortReason(detail, options)` の 1 関数へ集約する。コードが渡された場合は既存の書式 `code=<数値>` を含め、渡されない場合は含めない。これで malformed 打ち切りの 2 経路の非対称 (614-617 行目と 845-848 行目) が解消される
- wire へ載せる経路は、WebTransport の DOM API にコード付きの cancel が無いため現状では作れない。UA がコード付きの abort を提供した場合に使う拡張点を `cancelStreamQuiet` の中に 1 か所だけ置き、無い場合は現行の文字列 reason へフォールバックする。この制約と §12.5 の SHOULD を満たしていないことを `cancelStreamQuiet` の JSDoc に明記し、0646 の残課題を未解決のまま追跡する状態にする
- コードを渡す経路は `EXCESSIVE_LOAD` (0x9) と `MALFORMED_TRACK` (0x12) の 2 つにする。pending mode の abandon と fill の通常失敗は、仕様上どのコードが対応するかが自明でないため `errorCode` を渡さない (コード無し) ことを明示する。この判断も JSDoc に書く
- アプリへ渡す error の `streamErrorCode` (0646 の実装) は変えない。本 issue は wire 側の対称性だけを扱う
- 公開 API のシグネチャと挙動は変わらないため `CHANGES.md` には追記しない
- `src/session.test.ts` に、渡したコードが reason の `code=` に反映されること、コードを渡さない経路が `code=` を含まないこと、malformed の 2 経路が同じ書式になることを固定するテストを追加する

## 完了条件

- `cancelStreamQuiet` が理由コードを引数で受け取れる
- 上限超過の打ち切りが `EXCESSIVE_LOAD` (0x9) を、FETCH と Subgroup の malformed 打ち切りが `MALFORMED_TRACK` (0x12) を、同じ書式で reason に含める
- reason 文字列の組み立てが 1 関数へ集約され、`code=` の書式が全経路で統一される
- コードを渡さない経路 (pending mode の abandon、fill の通常失敗) は `code=` を含まない
- wire 上の STOP_SENDING にコードを載せられない制約と §12.5 の SHOULD を満たしていないことが `cancelStreamQuiet` の JSDoc に書かれている
- アプリへ渡す error の `streamErrorCode` の挙動が変わらない
- `npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-transport-21 §12.5 (Stream Reset Error Codes。冒頭の SHOULD と EXCESSIVE_LOAD 0x9 / MALFORMED_TRACK 0x12)。本文は `refs/moq/draft-ietf-moq-transport-21.txt` の 6675-6710 行目
- draft-ietf-moq-transport-21 §12.1 (Malformed Tracks の打ち切り)
- closed `0646-bug-data-stream-buffer-limit.md` (打ち切りを入れた issue。残した課題に `cancelStreamQuiet` の制約がある)
- W3C WebTransport (https://www.w3.org/TR/webtransport/)。`ReadableStream` の cancel には application error code を渡す引数が無い

## 解決方法

{未着手}
