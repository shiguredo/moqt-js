# 送信中の write が解決しない場合、Session 終了後もストリームが解放されない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-namespace-stream-release-on-stuck-write
- Polished: 2026-11-15
- Refreshed: 2026-11-14

## 目的

`Session.publishNamespace()` の送信待ちの間は `pendingNamespacePublication` が reject 関数だけを保持しており、ストリームを保持していない。そのため送信待ちの間に Session が終了して Promise が reject しても、`writer.write` の await が解決する (成功または失敗する) まで reader / writer のロックとストリームが解放されない。実 WebTransport では Session の終了で write が reject する想定だが、ライブラリの契約として「Session 終了時にストリームを解放する」ことを write の settle に依存させている。本 issue は `publishNamespace` だけを対象とし、request 系 / 購読系の同型の窓は 0933 の残した課題として別に扱う。

## 現状

- `src/session/namespaces.ts` の `namespacesSendPublishNamespace` は、`writer.write` の await が返ってから `namespacesCleanupSendFailure` で reader / writer を解放する
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests` は `pendingNamespacePublication` の reject を呼ぶだけで、ストリームには触れない
- 0890 のテスト「close 後に write が完了したらストリームを解放する」は、write を解放してから解放を確認しており、write が解決しない場合を固定していない
- `SessionImpl` は送信中のストリームを保持していない

## 設計方針

`pendingNamespacePublication` のエントリに、reject に加えてストリーム (または reader / writer) とクリーンアップ関数を保持する。

- `namespacesSendPublishNamespace` はストリーム作成後にエントリへストリームを登録する
- `sessionRejectPendingRequests` は reject を呼んだ後に、登録されたクリーンアップを fire-and-forget で実行する。クリーンアップは `namespacesCleanupSendFailure(streamReader, writer, "session closed")` とし、reader / writer のロックも解放する (`namespacesCancelStream` は cancel / abort だけでロックを解放しないため、これだけではストリームが解放されない)。cancel / abort の理由は、既存の Session 終了経路 (`namespacesSendPublishNamespace` の閉じていた経路) と同じ `"session closed"` とする (ピア起点の終了でも同じ)
- write の await が後から解決した場合は、既に解放済みでも失敗を無視する (`namespacesCleanupSendFailure` は失敗を無視する実装)
- 代替案として、契約を「write の settle 後に解放する」と明記し、write が解決しない場合を既知の制約としてテストで固定する案もある。代替案を採る場合は、完了条件の「Session の終了時に、write が解決していなくても送信中のストリームが解放される」を「write の settle 後に解放する」に読み替え、`docs/LOW_LEVEL_API.md` と JSDoc をその契約に合わせる。本 issue の目的 (write の settle に解放を依存させない) からは、上の設計を採る

## 完了条件

- Session の終了時に、write が解決していなくても送信中のストリームが解放される (解放は fire-and-forget で非同期に進むため、テストは解放の完了を待ってから検証する)
- write が後から解決した場合も二重解放で失敗しない
- 上記をテストで固定する (write を解放しない transport で close し、cancel / abort の理由が `"session closed"` であり、reader / writer のロックが解放されることを確認する)
- docs と JSDoc を実装に合わせる (`docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」、`Session.publishNamespace` と `pendingNamespacePublication` の JSDoc、`NamespacePublicationState.reject` の JSDoc)
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。

## 参照

- `src/session/namespaces.ts` の `namespacesSendPublishNamespace` / `namespacesCleanupSendFailure` / `namespacesCancelStream`
- `src/session/lifecycle.ts` の `sessionRejectPendingRequests`
- `src/session.ts` の `pendingNamespacePublication` と `Session.publishNamespace` の JSDoc
- `src/session/types.ts` の `NamespacePublicationState.reject` の JSDoc
- `src/session.test.ts` の `createHeldBidiStreamTransport` と送信待ちのテスト群
- `docs/LOW_LEVEL_API.md` の「Namespace 系の扱い」の `publishNamespace()` の項目
- closed の `0890-bug-publish-namespace-pending-settle.md` (送信待ちの間の Session 終了とストリームの解放の契約)
- closed の `0933-bug-subscribe-namespace-pending-settle.md` の「残した課題」 (request 系 / 購読系の同型の窓)
- draft-ietf-moq-transport-23 §6.6
