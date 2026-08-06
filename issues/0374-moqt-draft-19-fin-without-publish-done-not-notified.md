# PUBLISH_DONE なしの FIN で subscriber の end / error コールバックが呼ばれない

- Priority: Low
- Created: 2026-08-06
- Completed: {YYYY-MM-DD}
- Model: DeepSeek V4 Flash
- Branch: feature/fix-moqt-draft-19-fin-without-publish-done-not-notified
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §3.3.2 の「An endpoint that receives a FIN before all required messages have arrived treats the request as failed.」に従い、Established subscription でピアが PUBLISH_DONE を送らずに FIN した場合に subscriber へ失敗を通知する。現在はマップから削除されるだけで、end / error コールバックが呼ばれず state が "active" のまま残る。

## 優先度根拠

ピアが FIN を送った時点でサブスクリプションは失敗扱いになる (§3.3.2)。アプリケーションに通知されないため、リソースリークとユーザーへの不透明な動作につながる。Low。

## 現状

- `src/session/bidi.ts:667` でピアの FIN (`done`) を検出するとループを抜け、`finally` ブロック (`bidi.ts:840-851`) で `session.subscribers.delete(requestId)` と `subscribersByAlias` からの除去のみを行う。
- `impl.state` は "active" のまま、`end` / `error` コールバックは呼ばれない。
- 同じ問題が受信 PUBLISH ストリームの `src/session.ts:3183` にも存在する。

## 設計方針

- PUBLISH ストリームで PUBLISH_DONE を受信せずに FIN を検出した場合、該当 subscriber の `error` コールバック (または `end` 相当の失敗通知) を呼び、state を closed に遷移させる。
- 受信 PUBLISH ストリーム (`session.ts`) 側も同様に処理する。
- 正常な PUBLISH_DONE → FIN の経路 (`bidiHandlePublishDone`) には影響させない。

## 完了条件

- Established subscription でピアが PUBLISH_DONE なしに FIN した場合、subscriber の error コールバックが呼ばれ state が closed になること。
- 正常な PUBLISH_DONE → FIN の経路では end コールバックが従来どおり呼ばれること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 参照

- draft-ietf-moq-transport-19 §3.3.2 (Graceful Request Stream Closure)

## 解決方法

未着手。
