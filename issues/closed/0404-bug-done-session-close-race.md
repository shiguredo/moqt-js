# セッション close と done() の並行実行で close 失敗が誤って PROTOCOL_VIOLATION に昇格する

- Created: 2026-08-10
- Completed: 2026-08-16
- Branch: feature/fix-done-session-close-race
- Polished: 2026-08-16

## 目的

`session.close()` (src/session.ts) と `publisher.done()` の並行実行で、`publishSendPublishDone` の close 失敗が PROTOCOL_VIOLATION に誤昇格し、`callbacks.error` に誤った違反通知が流れる経路を塞ぐ。この失敗はローカルの abort / セッション終了起因でありピアは何も違反していないため、ピアの違反とみなすこの通知は誤報である。

## 現状

- `session.close()` は sessionState を同期で "closed" にしてから、fire-and-forget で保持中の request stream writer を `abortWriterSafely` (src/session.ts) により abort する。
- `publishSendPublishDone` (src/session/publish.ts) は issue 0370 で sessionState ガード (closed なら return) を追加済み。ただし、これは「チェック時点で既に closed」の場合のみ有効であり、ガード通過後に session.close() の abort が走る並行レースは防げない。
- レース成立時、close は abort 起因のエラーで reject し、close 失敗が PROTOCOL_VIOLATION に昇格して `closeWithError` → `callbacks.error` に通知される。セッションは既に閉じているため (`close()` は sessionState === "closed" で即 return)、この通知は誤報である。
- 同じ誤昇格経路は、ガード通過後にピア起因のセッション終了 (`transport.closed` → sessionState = "closed"。遷移は非同期) が起きた場合にも存在する。どちらの経路も closeWithError 前の sessionState 再確認で塞がれる。ただしピア起因経路は sessionState 遷移が非同期であるため、write / close の reject が sessionState 遷移より先に処理された場合、再確認時点でまだ "connected" のまま通過し得る。この順序前提 (ストリームの reject 処理時には sessionState 遷移が完了していること) はピア起因経路のテスト設計で固定する。
- issue 0370 の「ピア FIN 後の requestStreams 保持」により、done() が実際に write / close を実行する機会が増え、発現面が広がった。なお本レース自体は 0370 修正前にも存在し得る pre-existing である。

## 設計方針

- 修正方式は「`publishSendPublishDone` の closeWithError 呼び出し前に sessionState を再確認し、閉じていたら昇格しない」方式に確定する。abort 起因の失敗は環境によりエラー形式がばらつき (Node では source なしの TypeError)、source プロパティでは真のプロトコル違反と区別できないため、失敗の判定による方式 (案 B) は不採用。
- ローカルの `writer.abort()` 起因の失敗に source: "stream" が付かないことは W3C WebTransport 仕様に整合する (source "stream" は対向からのシグナルのみで付与され、ローカル abort は abort reason で error する)。ただし実環境 (ブラウザ / Node) による形式のばらつきを考慮し、判定を source に依存させない方針のため、この事実に実装が依存しない。
- セッション終了後の送信試行をガードする既存の sessionState チェック (issue 0370 で追加) と整合させ、ガード通過後の再確認として追加する (入り口ガードは維持する)。
- 代替案として `closeWithError` (src/session.ts) 側で sessionState が "closed" なら `callbacks.error` を呼ばない中央ガードも考えられるが、`closeWithError` は全違反経路の共通出口であり、closed 状態での黙殺は並行 read loop がほぼ同時に検出した真の違反通知まで失わせる。対象経路に限定できる `publishSendPublishDone` 側の再確認を採用する。
- 変更対象ファイル: `src/session/publish.ts` (`publishSendPublishDone` の closeWithError 前の sessionState 再確認)、`src/session/bidi.test.ts` (テスト追加。publishSendPublishDone の既存テスト配置)、`CHANGES.md`。

## 完了条件

- session.close() と publisher.done() を並行実行しても、callbacks.error に PROTOCOL_VIOLATION が通知されないこと。
- セッションが正常に閉じること (close() が通常どおり完了し、callbacks.close が呼ばれること)。
- ガード通過後のピア起因セッション終了でも、callbacks.error に PROTOCOL_VIOLATION が通知されないこと。
- 正常な PUBLISH_DONE 送信経路 (セッション生存中の done()) の挙動が変わらないこと (回帰ガード)。
- 上記を検証するテストがあること (入り口ガードと再確認の両経路を区別したテスト構成: セッション生存中の正常 done() の回帰ガード、close() と並行する done() で closeWithError が呼ばれないこと、ピア起因セッション終了経路の順序前提)。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.5 (Termination)
- draft-ietf-moq-transport-19 §10.11 (PUBLISH_DONE)
- 関連: `issues/0403-bug-parallel-done-race.md`（並行 done()。本 issue とはトリガーが異なる。0403 の in-flight ガードでは本レース (セッション closed 起因) は防げず、本 issue の sessionState 再確認では 0403 のレース (セッション connected のまま) は防げない）
- 関連: `issues/closed/0370-moqt-draft-19-publish-done-skipped-after-peer-fin.md`（sessionState ガードの追加経緯）

## 解決方法

- `src/session/publish.ts` の `publishSendPublishDone` の close 失敗時、`closeWithError` の前に sessionState を再確認し、入り口ガード (関数先頭の sessionState チェック) 通過後にセッションが閉じていた場合は PROTOCOL_VIOLATION に昇格しないようにした。クリーンアップ (requestStreams / publishers からの削除) は従来どおり実行される。
- 再確認は TS の制御フロー絞り込み (入り口ガードで "connected" に絞られる) を `as SessionState` で解除して実状態を評価する。キャストはコンパイル必須 (await をまたいでも絞り込みが維持されるため、TS2367 になる)。
- ピア起因のセッション終了 (transport.closed) は sessionState 遷移が非同期のため、reject 処理時に遷移が完了している場合のみ再確認が機能する。遷移より先に reject が処理された場合は昇格し得る既知の残余リスクとしてコメントに明記した (エラーの source 判定に依存しない設計のため)。
- テスト: `src/session/bidi.test.ts` に 2 本追加 (close() と並行実行で close 失敗時に sessionState closed → 昇格しない / ピア起因のセッション終了で遷移完了済み状態 → 昇格しない。ピア起因は write 失敗 + close 失敗のシナリオで、write フック不発の退化を検出する events 検証付き)。`forceSessionClosed` ヘルパーを追加し、既存テストの sessionState 変更も共通化した。
- 既存の「close 失敗 (source なし) で closeWithError(PROTOCOL_VIOLATION) が呼ばれる」テストは sessionState が "connected" のままのため、従来どおり昇格する (回帰ガード)。
