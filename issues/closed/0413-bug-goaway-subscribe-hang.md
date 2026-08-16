# GOAWAY 受信後の read 例外で namespace / tracks の subscribe() が永不解決になる

- Priority: Medium
- Created: 2026-08-12
- Completed: 2026-08-16
- Branch: feature/fix-goaway-subscribe-hang
- Polished: {YYYY-MM-DD}
- Updated: 2026-08-15

## 目的

SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS ストリームの受信ループ (`src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop`) で、GOAWAY 受信後 (REQUEST_OK 未受信のまま) に read 例外 (ピアの RESET_STREAM 等) が発生した場合、`subscribeNamespace()` / `subscribeTracks()` の Promise が永不解決になる問題を解消する。

## 現状

- done (FIN) 経路は `resolved === false` なら goawayReceived の有無に関わらず `reject` する (`namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop` の `if (done)` ブロック)。
- 一方 catch 経路は `subscription.state === "active" && !goawayReceived` の内側でのみ `reject` するため、GOAWAY 受信後 (goawayReceived=true) の read 例外では reject されない。
- 結果として、GOAWAY 受信後にピアがストリームを RESET で閉じた場合、`subscribeNamespace()` / `subscribeTracks()` の Promise が永不解決のまま残る (done 経路と catch 経路の挙動不一致)。
- なお、この経路は現状のコードでは到達不能である: 先頭メッセージガード (`!resolved` 時は REQUEST_OK / REQUEST_ERROR 以外を PROTOCOL_VIOLATION でセッションクローズ。src/session/namespaceLoops.ts) により、resolved=false の時点で GOAWAY を受信するとセッションが閉じるため、goawayReceived=true かつ resolved=false の状態は発生しない。本経路は open issue 0407 (先頭 GOAWAY の許可) 解決後に初めて発生し得る。ただし 0407 の設計方針 (resolved=false の GOAWAY は reject + cancel) どおり実装されると本 issue の対象経路は消滅するため、0407 の実装方針確定後に本 issue の要否を再評価する必要がある。
- `namespaceStartPublicationStreamLoop` も同様の構造だが、GOAWAY 受信時 (resolved=false) に reject + cancel するため、本 issue の影響はない (確認済み)。
- 関連: `issues/0407-fix-initial-goaway-on-namespace-stream.md` (先頭 GOAWAY の PROTOCOL_VIOLATION 問題。本 issue は GOAWAY 受信後の read 例外経路の別問題)。

## 設計方針

- catch 経路で `resolved === false` の場合、goawayReceived の有無に関わらず `reject` する (done 経路と同様の扱い)。
- `state` 遷移と `callbacks.error` 通知は従来どおり `!goawayReceived` の内側に維持する (GOAWAY 後の spurious error 通知の抑止は変えない)。

## 完了条件

- GOAWAY 受信後 (REQUEST_OK 未受信) に read 例外が発生しても、`subscribeNamespace()` / `subscribeTracks()` の Promise が reject されること。
- GOAWAY 非受信時の既存の挙動 (reject + callbacks.error) が維持されること。
- 上記を検証するテストがあること。

## 解決方法

未着手。

## closed にした理由

- 本 issue の対象経路 (goawayReceived=true かつ resolved=false の状態での read 例外) は現状のコードで到達不能である。先頭メッセージガード (`src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop`) が resolved=false の GOAWAY を PROTOCOL_VIOLATION でセッションクローズにするため、`goawayReceived=true && resolved=false` の状態は現状発生しない (polish-issue 本審で検証済み)。
- 0407 (先頭 GOAWAY の許可) は 2026-08-15 に polish 済みであり、その設計方針 (resolved=false の GOAWAY は callbacks.goaway 通知 → reject → `streamReader.cancel()` → ループ終了) により、0407 実装後も本 issue の対象経路は発生しない (reject + cancel + return で即ループ終了するため)。0413 自身の記述「0407 の設計方針どおり実装されると本 issue の対象経路は消滅する」に照らし、要否再評価のトリガーは発火済みであり、評価結果は「対象経路消滅」。
- 完了条件のテスト (resolved=false で GOAWAY 受信後に read 例外を再現) は、現行・0407 実装後のいずれのコード経路でも構築不能である。
- 以上により、本 issue の対象問題は存在しないと確定したため closed とする。万一 0407 の実装が設計方針から逸脱した場合 (resolved=false の GOAWAY で読み取りを継続する実装になった場合) は、新規 issue として起票し直す (reopened の対象は open issue のみのため)。

## pending にした理由

- 本 issue の対象経路 (goawayReceived=true かつ resolved=false の状態での read 例外) は現状のコードで到達不能である。先頭メッセージガード (`src/session/namespaceLoops.ts` の `namespaceStartNamespaceStreamLoop` / `namespaceStartTracksStreamLoop`) が resolved=false の GOAWAY を PROTOCOL_VIOLATION でセッションクローズにするため、`goawayReceived=true && resolved=false` の状態は現状発生しない (polish-issue 本審で検証済み)。
- 0407 (先頭 GOAWAY の許可) は 2026-08-15 に polish 済みであり、その設計方針 (resolved=false の GOAWAY は callbacks.goaway 通知 → reject → `streamReader.cancel()` → ループ終了) により、0407 実装後も本 issue の対象経路は発生しない (reject + cancel + return で即ループ終了するため)。0413 自身の記述「0407 の設計方針どおり実装されると本 issue の対象経路は消滅する」に照らし、要否再評価のトリガーは発火済みであり、評価結果は「対象経路消滅」。
- 完了条件のテスト (resolved=false で GOAWAY 受信後に read 例外を再現) は、現行・0407 実装後のいずれのコード経路でも構築不能である。
- 対応方針: 0407 の実装完了時に本 issue を closed にする。万一 0407 の実装が設計方針から逸脱した場合 (resolved=false の GOAWAY で読み取りを継続する実装になった場合) のみ、本 issue を reopened にして対応する。
