# subscribe ロールのエラー終了 (RESET_STREAM 等) 時に subscriber の終了通知が失われる

- Created: 2026-08-11
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subscribe-error-end-not-notified
- Polished: {YYYY-MM-DD}

## 目的

`bidiReadRequestStreamMessages` (`src/session/bidi.ts`) の subscribe ロールで、ピアが RESET_STREAM / STOP_SENDING 等でストリームをエラー終了させた場合に、subscriber の error コールバックが呼ばれず state が "active" のまま残る問題を修正する。FIN (PUBLISH_DONE なし) 経路の終了通知は closed issue 0374 で実装済みだが、エラー終了経路は対象外として記録されたまま未対応である。

## 現状

- `bidiReadRequestStreamMessages` の外側 catch は `toProtocolViolationSessionError` (`src/session/errors.ts`) で ProtocolViolationError のみ PROTOCOL_VIOLATION の SessionError に変換してセッションを閉じ、それ以外 (ピアの RESET_STREAM 等による WebTransportError 等) は黙殺する。
- 黙殺された場合も finally は実行され、`subscribers` / `subscribersByAlias` / `requestStreams` からエントリが削除されるが、subscriber の error コールバックも state 遷移も行われない。アプリは subscription が終了したことを検知できず、state が "active" のまま残る。
- 同種の終了通知欠落は FIN 経路で closed issue 0374 が解決済み (`notifySubscriberFin`: error 通知 + markClosed)。受信 PUBLISH 経路 (`src/session.ts` の `runPublishStreamSubLoop`) は catch で `impl.state === "active"` のとき error コールバックを呼ぶため、subscribe ロールの読み取り経路のみが非対称に未対応のままである。

## 設計方針

- **通知の契機**: `bidiReadRequestStreamMessages` の外側 catch で、`toProtocolViolationSessionError` が null を返す (ProtocolViolationError 以外) 場合に subscriber のエラー終了として通知する。このケースの代表例はピアの RESET_STREAM / STOP_SENDING によるストリームエラーであり、プロトコル違反ではないためセッションは閉じない。
- **通知方法**: closed issue 0374 の `notifySubscriberFin` (error 通知 → markClosed、ガード 3 種) を流用するか、同様のガード付きのエラー通知専用処理にするかを実装時に確定する。エラー文言は FIN 経路 (publisher closed request stream without PUBLISH_DONE) と区別できるものにする。
- **ガード**: notifySubscriberFin と同様、subscribers に存在しない場合・state が "active" でない場合は通知しない。GOAWAY 受信済みの場合の扱い (FIN 経路は通知しないが、エラー終了はストリームが実際に破壊されているため通知すべきか) は実装時に確定し、テストで固定する。
- **テスト**: 0374 方式の実 W3C ストリーム注入 (モック不使用) で、RESET_STREAM 相当のエラー終了 (reader.read() が WebTransportError で reject する) を再現して error コールバック + state closed を検証する。

## 完了条件

- subscribe ロールでピアの RESET_STREAM / STOP_SENDING 等によるエラー終了を検出した場合、subscriber の error コールバックが呼ばれ state が closed になること。
- セッションは閉じないこと (ProtocolViolationError ではないため)。
- 正常な PUBLISH_DONE → FIN 経路は従来どおり end コールバックのみ呼ばれること (closed issue 0374 のテストと整合)。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- 関連: `issues/closed/0374-moqt-draft-19-fin-without-publish-done-not-notified.md`（FIN 経路の終了通知。エラー終了経路は本 issue の対象として記録された）
- 関連: `issues/0409-bug-publish-stream-request-update-decode-failure.md`（publish ロールの終了通知欠落）
- 関連: `issues/closed/0405-bug-subscribe-fin-response.md`（subscribe ロールの FIN 応答）
