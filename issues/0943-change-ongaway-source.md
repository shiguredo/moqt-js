# onGoaway が GOAWAY の由来 (制御ストリーム / リクエストストリーム) を区別できない

- Created: 2026-11-03
- Completed: {YYYY-MM-DD}
- Branch: feature/change-ongaway-source
- Polished: {YYYY-MM-DD}

## 目的

高レベル API の `onGoaway(newSessionUri)` は新しい Session URI だけを渡すため、アプリは GOAWAY が Session の制御ストリーム由来 (セッション全体の移行) か、SUBSCRIBE / PUBLISH / PUBLISH_NAMESPACE / FETCH のリクエストストリーム由来 (そのリクエストだけの移行) かを区別できない。draft-ietf-moq-transport-22 §9.2 と §6.6.1 は両者を別の意味で定めており、アプリの対応 (インスタンス全体の作り直し / 特定のリクエストの再発行) が変わる。

## 現状

- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway` は `(newSessionUri: string) => void` である
- 0891 では通知のみを実装し、由来を区別しない契約で docs を書いた
- 抑止は URI だけで行うため、リクエストストリームの GOAWAY A の直後に制御ストリームの GOAWAY A が来ると、制御側 (セッション全体の移行) が抑止される
- docs は「どの GOAWAY でもインスタンスを止めて作り直す」と読める書き方で、リクエスト単位の移行を扱えない

## 設計方針

`onGoaway` の引数に由来を足すか、制御ストリームとリクエストストリームで通知を分ける。公開 API の変更になるため、既存の利用者への影響を最小にする。

- 案 A: `onGoaway?: (newSessionUri: string, info: { source: "session" | "request"; request?: "subscribe" | "publish" | "publish_namespace" | "fetch" }) => void` に広げる
- 案 B: `onSessionGoaway` と `onRequestGoaway` に分ける
- 案 C: 通知は URI だけのまま、docs で「すべての GOAWAY はセッション全体の再接続として扱う」と明記し、抑止もその前提で説明する

高レベル API に単一リクエストの再発行 API が無い現状では、案 A / B の実益は限定的である。案 C を採るなら、抑止がスコープをまたぐ問題を docs で説明し、`source` を将来追加する余地を JSDoc に残す。

## 完了条件

- GOAWAY の由来をアプリが扱えるようになるか、扱わない契約が docs と JSDoc に明記されている
- 抑止がスコープをまたぐ問題の扱いが決まっている
- 選んだ案の挙動をテストで固定する
- `vp check` と `vp test --run` が通る

`CHANGES.md` は MOQT RFC ドラフト中のため更新しない (`CODEBASE.md` の特別ルール)。公開 API の変更になる場合は `### misc` ではなく変更種別に従う。

## 参照

- `src/codec/types.ts` の `MediaSubscriberCallbacks.onGoaway` / `MediaPublisherCallbacks.onGoaway`
- `src/createMediaSubscriber.ts` / `src/createMediaPublisher.ts` の `notifyGoaway`
- `docs/HIGH_LEVEL_API.md` の「GOAWAY の扱い」
- draft-ietf-moq-transport-22 §9.2 / §6.6.1
