# 送信中の write が解決しない場合、Session 終了後もストリームが解放されない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-stream-release-on-stuck-write
- Polished: {YYYY-MM-DD}

## 目的

`Session.publishNamespace()` の送信待ちの間は `pendingNamespacePublication` が reject 関数だけを保持しており、ストリームを保持していない。そのため送信待ちの間に Session が終了して Promise が reject しても、`writer.write` の await が解決する (成功または失敗する) まで reader / writer のロックとストリームが解放されない。実 WebTransport では Session の終了で write が reject する想定だが、ライブラリの契約として「Session 終了時にストリームを解放する」ことを write の settle に依存させている。

## 現状

- `src/session/namespaces.ts` の `namespacesSendPublishNamespace` は、`writer.write` の await が返ってから `namespacesCleanupSendFailure` で reader / writer を解放する
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `pendingNamespacePublication` の reject を呼ぶだけで、ストリームには触れない
- 0890 のテスト「close 後に write が完了したらストリームを解放する」は、write を解放してから解放を確認しており、write が解決しない場合を固定していない
- `SessionImpl` は送信中のストリームを保持していない

## 設計方針

`pendingNamespacePublication` のエントリに、reject に加えてストリーム (または reader / writer) とクリーンアップ関数を保持する。

- `namespacesSendPublishNamespace` はストリーム作成後にエントリへストリームを登録する
- `sessionRejectPendingRequests` は reject を呼んだ後に、登録されたクリーンアップ (cancel / abort) を fire-and-forget で実行する
- write の await が後から解決した場合は、既に解放済みでも失敗を無視する (`namespacesCleanupSendFailure` は失敗を無視する実装)
- 代替として、契約を「write の settle 後に解放する」と明記し、テストで write が解決しない場合の既知の制約として固定する案もある。実装する場合は `docs/LOW_LEVEL_API.md` を更新する

## 完了条件

- Session の終了時に、write が解決していなくても送信中のストリームが解放される
- write が後から解決した場合も二重解放で失敗しない
- 上記をテストで固定する (write を解放しない transport で close する)
- docs と JSDoc を実装に合わせる
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesSendPublishNamespace` / `namespacesCleanupSendFailure` / `namespacesCancelRawStreamQuiet`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests`
- `src/session.ts` の `pendingNamespacePublication`
- `src/session.test.ts` の `createHeldNamespaceTransport` と送信待ちのテスト群
- draft-ietf-moq-transport-22 §6.6
