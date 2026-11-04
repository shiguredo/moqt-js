# 重なる namespace prefix への更新を許可し NAMESPACE_DONE の暗黙適用を処理する

- Created: 2026-11-03
- Completed: 2026-11-04
- Branch: feature/change-moqt-draft-23
- Polished: 2026-11-03

## 目的

draft 23 §4.2 / §9.5.2 は prefix の overlap 制約を削除し、SUBSCRIBE_NAMESPACE の更新成功時に、新 prefix に一致しなくなった namespace の NAMESPACE_DONE を暗黙に適用する。現在は合法な更新を拒否し、active namespace の再構成も行わない。

## 現状

- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` は他の active prefix を集め、`validateNamespacePrefixUpdate` で重なりを拒否する
- `src/session/params.ts` の同検証は draft 22 の PREFIX_OVERLAP を前提とする
- `src/session/namespaceLoops.ts` の `handleNamespaceRequestUpdateOk` は prefix を差し替え、`createNamespaceStreamHandlers` は seen suffixes を clear するだけで、active tracker を新しい prefix に合わせない

## 設計方針

- SUBSCRIBE_NAMESPACE / SUBSCRIBE_TRACKS の overlap によるローカル拒否を除く。予約 namespace、未確立・終了済み要求、in-flight 更新のガードは維持する
- namespace の追跡は旧 prefix と suffix から Full Namespace を復元して扱う。更新 ACK の時点で新 prefix に一致しない active namespace を終了通知し、残る namespace の suffix を新 prefix 基準へ付け替える
- 旧 namespace の終了通知は旧 prefix 基準で完了させてから新 prefix を反映する。ACK より前後の NAMESPACE / NAMESPACE_DONE がどちらの prefix に相対するかをテストと API 文書で固定する
- 更新失敗時は旧状態を維持する。FIN / RESET で同じ namespace の終了を再通知しない
- SUBSCRIBE_TRACKS の既存の個別購読を保持し、origin ID による対応付けは 0905 を使う。publisher が同じ要求へ重複 PUBLISH しない規則は relay の実装として追加しない

## 完了条件

- 同一・包含関係の prefix への更新が送信できる
- prefix の拡大 / 縮小 / 別枝への移動、保持される namespace、暗黙に終了する namespace を検証する
- ACK の前後、REQUEST_ERROR、callback 例外、FIN / RESET による終了通知の重複が無い
- PREFIX_OVERLAP の削除は 0915 と整合し、旧コメント・API の制約記述を残さない

## 参照

- `refs/moq/draft-ietf-moq-transport-23.txt` §3.6 / §4.2 / §9.5.2 / §9.19.20
- `src/session/params.ts` の `validateNamespacePrefixUpdate`、`src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate`
- `src/session/namespaceLoops.ts` の `createNamespaceActiveTracker` / `handleNamespaceRequestUpdateOk`

## 解決方法

- draft-23 §4.2 / §9.5.2 で prefix の overlap 制約が削除されたため、`src/session/params.ts` の `validateNamespacePrefixUpdate` と、そのためだけに存在した `namespacePrefixesOverlap` を削除した。予約 namespace、未確立・終了済み要求、in-flight 更新、GOAWAY のガードは維持している。
- `src/session/bidi.ts` の `bidiSendNamespaceRequestUpdate` から、他の active prefix を集めて重なりを拒否する処理を削除した。同一型・別型を問わず任意の prefix へ更新を送信できる。
- `src/session/namespaceLoops.ts` の `createNamespaceActiveTracker` を Full Namespace (旧 prefix + suffix) をキーに保持する形へ変更し、`applyPrefixUpdate` を追加した。REQUEST_UPDATE_OK 受理時に、新 prefix に一致しない namespace を旧 prefix 基準の suffix で `onNamespaceDone` に 1 回通知してから削除し、残る namespace の suffix を新 prefix 基準へ付け替える。NAMESPACE_DONE の重複検証キーも新 suffix で組み直す。
- ACK より前の NAMESPACE / NAMESPACE_DONE は旧 prefix 基準、ACK 後は新 prefix 基準として扱う。旧 namespace の終了通知は新 prefix を反映する前に旧基準で完了させ、暗黙 DONE 後の FIN / RESET 補完は再通知しない。
- 更新失敗 (REQUEST_ERROR) では tracker を変更せず旧 prefix のまま FIN 補完する。callback 例外は既存方針どおり握り潰して組み替えを継続する。
- SUBSCRIBE_TRACKS は NAMESPACE 追跡を行わないため再構成は不要で、確立済みの個別購読は取消さない。
- `src/session/publicTypes.ts` の `NamespaceSubscription.update` / `TracksSubscription.update` の API 文書から overlap 制約の記述と `PREFIX_OVERLAP` の例を削除し、ACK 後の suffix 基準・暗黙 NAMESPACE_DONE・既存個別購読の維持を明記した。
- テストは prefix の縮小 (暗黙 DONE・旧/新 suffix 基準・FIN 重複なし)、拡大、別枝への移動、更新失敗時の旧状態維持、暗黙 DONE の callback 例外、重なる prefix への更新送信を検証する。
- `RequestErrorCode.PREFIX_OVERLAP` の登録コード削除は、登録コード同期を担当する issue に委ねた。

### 既知の制限

- `RequestErrorCode.PREFIX_OVERLAP` は定数として残っている (登録コードの同期は別 issue)。
- docs は 0925 で一括更新するため触っていない。
- 実リレー E2E は統合ブランチの制約 (ALPN は移行完了まで moqt-22) のため未実施である。

### 残課題 (別 issue で扱う)

- エラーコード登録の同期 (0915)
- docs の一括更新 (0925)

{未着手}
