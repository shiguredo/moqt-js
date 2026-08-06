# .session namespace / 予約 namespace の送信を拒否する

- Created: 2026-08-07
- Completed: 2026-08-07
- Branch: feature/add-reserved-namespace-rejection
- Polished: (未磨き上げ)

## 目的

draft-ietf-moq-transport-19 §3.2.1 / §3.2.2 は予約 namespace と session-level namespace の利用を禁止している。moqt-js は判定関数を定義済みだが送信経路で未使用であり、アプリケーションが誤って `.session` namespace や予約 namespace で publish / subscribe してしまうのを防げない。draft-19 対応のリリースに備えて送信を拒否する。

## 現状

- `isReservedNamespace` / `isSessionLevelNamespace` (`src/message/parameter.ts`) と `RESERVED_NAMESPACE_PREFIX` / `SESSION_LEVEL_NAMESPACE` 定数は定義され公開されているが、`src/` 内のどの呼び出し元からも使われていない。
- `SessionImpl.publish` / `subscribe` / `fetch` / `trackStatus` / `subscribeNamespace` / `subscribeTracks` / `publishNamespace` (`src/session.ts`) は namespace の先頭フィールドを検証せずに Track Namespace を構築して送信する。

## 設計方針

draft-ietf-moq-transport-19 の記述に従う:

- §3.2.1 (Reserved Namespaces): "MOQT reserves all Track Namespace values whose first tuple field begins with a period (0x2e, .). These namespaces MUST NOT be used unless their meaning is defined through IANA registration." また "A Track Namespace whose first field is exactly . (a single period, 0x2e) is reserved and MUST NOT be used for any purpose."
- §3.2.2 (Session-Level Tracks and Namespaces): "The Application MUST NOT publish tracks or namespaces whose first field is .session." また "A request with a Track Namespace whose first field is .session and an empty Track Name MUST be rejected with DOES_NOT_EXIST."

実装方針:

- moqt-js はクライアント実装であり IANA 登録済みの予約 namespace を定義しないため、先頭フィールドが `.` で始まるすべての namespace (`.session` 含む) を送信対象として拒否する。
- 共通検証関数を `src/session/params.ts` に追加し、publish / subscribe / fetch / trackStatus / subscribeNamespace / subscribeTracks / publishNamespace の 7 経路で namespace の先頭フィールドを検証する。
- `.session` namespace かつ空の Track Name のリクエスト (subscribe / fetch / trackStatus / publish) は DOES_NOT_EXIST 相当のエラーメッセージで拒否する。
- 拒否は送信前の同期 throw とし、セッションは閉じない (アプリケーションの入力ミスでありプロトコル違反ではない)。

## 完了条件

- 先頭フィールドが `.` で始まる namespace (`.` / `.session` / `.foo` 等) を publish / subscribe / fetch / trackStatus / subscribeNamespace / subscribeTracks / publishNamespace に渡すと throw する。
- `.session` namespace + 空 Track Name の subscribe / fetch / trackStatus / publish は DOES_NOT_EXIST を意味するエラーメッセージで throw する。
- 正常な namespace (`.` で始まらない) は従来どおり送信できる。
- 上記の単体テストが追加され、`pnpm test` が全てパスする。

## 解決方法

- `src/session/params.ts` に `validateTrackNamespaceForSend` を追加する
  - 先頭フィールドが `.` で始まる namespace (`.session` / `.` / `.foo` 等) を送信対象として拒否する
  - `.session` + 空 Track Name の組み合わせは DOES_NOT_EXIST 相当のエラーメッセージで拒否する
  - 拒否は送信前の同期 throw とし、セッションは閉じない (アプリケーションの入力ミスでありプロトコル違反ではない)
- `SessionImpl.publish` / `subscribe` / `fetch` / `trackStatus` / `subscribeNamespace` / `subscribeTracks` / `publishNamespace` の 7 経路 (`src/session.ts`) で `createTrackNamespace` 後に呼び出す
- テスト: `src/session/params.test.ts` に `validateTrackNamespaceForSend` の単体テスト 7 本を追加する
