# PUBLISH_DONE 後の stream close 失敗で publisher セッションを閉じない

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/fix-publish-done-close-escalation
- Polished: {YYYY-MM-DD}

## 目的

relay が PUBLISH 購読を打ち切った (RESET_STREAM / STOP_SENDING) 直後に PUBLISH_DONE を送ったとき、bidi ストリームの close が失敗しても、publisher のセッション全体を閉じないようにする。

## 現状

2026-11-16 の別ノード構成 (devtools publisher をノード A、SUBSCRIBE_TRACKS 購読者をノード B) で観測した。

- relay は §7.7 の MUST に従い、SUBSCRIBE_TRACKS の後に上流の publisher へ通常の SUBSCRIBE を送る
- moqt-js はクライアント専用であり、受信 SUBSCRIBE を REQUEST_ERROR (NOT_SUPPORTED) で拒否する (`src/session/incoming.ts`)
- その後 relay が PUBLISH 購読を打ち切ると、publisher は PUBLISH_DONE を書いた後の `writer.close()` が `TypeError: Cannot close a ERRORED writable stream` で失敗する
- `src/session/publish.ts` の close 失敗処理は、`isPeerStreamError` が `source === "stream"` のエラーしか拾わないため、この TypeError を実装不具合とみなし、`INTERNAL_ERROR` でセッション全体を閉じる
- UI には `Error: failed to close stream after PUBLISH_DONE: Cannot close a ERRORED writable stream` が出て配信が止まる

同じ失敗は、ピアが先にストリームを reset した場合や、セッション終了と並行して close した場合にも起こり得る。

## 設計方針

- close 失敗が「writable が既に errored / closed である」ことを示す場合 (WHATWG Streams の `TypeError: Cannot close a ... writable stream` など) は、ピア起因またはローカル終了起因のストリーム終了として扱い、セッションを閉じない。`source === "stream"` を持たない実装 (Chromium / Node) があるため、メッセージの判定を `isPeerStreamError` に追加するか、close 失敗の判定を `publish.ts` に閉じて行う
- 本当の実装不具合 (writable が閉じていないのに close が失敗する等) は従来どおり `INTERNAL_ERROR` でセッションを閉じる。判定を広げすぎない
- 回帰テストを追加する。errored / closed の writable に対する close 失敗でセッションが閉じないこと、無関係な TypeError では閉じることを固定する
- 他の PUBLISH_DONE close 経路 (namespace 系の close など) に同じ昇格が無いか確認する
- 修正後、別ノードの SUBSCRIBE_TRACKS で publisher セッションが生き残ることを実リレーで再検証する

## 完了条件

- errored / closed の writable への close 失敗で publisher セッションが閉じない
- 無関係な close 失敗では従来どおり `INTERNAL_ERROR` で閉じる
- 単体テスト (回帰) が通り、`vp check` と `vp test run` が通る
- 別ノード再検証の結果を解決方法に記録する
- 残る問題 (受信 SUBSCRIBE 非対応による media 不達) は 0962 で扱う

## 参照

- `src/session/publish.ts` (PUBLISH_DONE 後の close 失敗処理)
- `src/session/errors.ts` (`isPeerStreamError`)
- `src/session/incoming.ts` (受信 SUBSCRIBE の NOT_SUPPORTED)
- draft-ietf-moq-transport-23 §6.4.2.3 / §9.9
- 関連 issue: 0962、0964

## 解決方法

コミット 67656e8e (PR #570) で修正済みであり、追加の対応は不要である。

- `src/session/errors.ts` に `isWritableStreamStateError` を追加した。WHATWG Streams が既に errored / closed の writable への write / close を TypeError で reject する実装のうち、次の文言だけをストリーム終了として扱う
  - Chromium (Blink): `Cannot close a ERRORED writable stream` / `Cannot close a CLOSED writable stream` / `Cannot write to a CLOSED writable stream`
  - Node.js (undici): `Invalid state: WritableStream is closed`
  - TypeError 以外と上記以外の文言は対象外とし、無関係な実装不具合をストリーム終了扱いにしない
- `src/session/publish.ts` の `isPublishDoneCloseFailureTermination` で、PUBLISH_DONE 後の close 失敗がピア起因 (`source === "stream"`) または writable の状態エラーである場合にセッションを閉じないようにした。write が状態エラー以外で失敗している場合は、close 失敗が状態エラーでもセッションを閉じる (PUBLISH_DONE を送れていない失敗を状態エラーが覆い隠さない)
- 回帰テストを追加した
  - `src/session/errors.test.ts`: `isWritableStreamStateError` が Chromium / Node.js の文言を true、無関係な TypeError と TypeError 以外を false にすること
  - `src/session/bidiHandlePublishRequestUpdate.test.ts`: write 成功後に errored になった writable の close 失敗、closed 状態の writable への close 失敗でセッションが閉じないこと、状態と無関係な TypeError では `INTERNAL_ERROR` で閉じること
- 他の close 経路に同じ昇格が無いことを確認した。`src/session/namespaceLoops.ts` の `namespaceCloseWriterQuiet` と GOAWAY の `writer.close()`、`src/session/incoming.ts` の `incomingSendRequestErrorAndClose`、`src/session/bidi.ts` の `closeRequestStreamWriter` は close 失敗を局所で握り潰しており、セッションを閉じる昇格は無い
- 別ノード再検証の結果は closed 0962 の解決方法に記録されている。既定の告知 + 別ノード構成で、初回の video PUBLISH と objects 419、PUBLISH_DONE 後の再配信で 2 回目の PUBLISH と objects 824 を確認し、subscriber の errors は空で、MALFORMED_TRACK と publisher セッションの閉鎖は再発していない
- 受信 SUBSCRIBE の NOT_SUPPORTED による media 不達は closed 0962 の範囲である。relay の上流 SUBSCRIBE を満たせないが、このトポロジでは PUBLISH 購読経由の配送が継続し、実害は観測されていない
- 検証: `vp test run` は 279 ファイル / 5262 テストが通った。`vp check` は修正対象の 4 ファイル (`src/session/errors.ts` / `src/session/publish.ts` / `src/session/errors.test.ts` / `src/session/bidiHandlePublishRequestUpdate.test.ts`) で通った。全リポジトリの `vp check` は closed 0964 の既存の余分な空行だけを検出する (本 issue の変更範囲外)
