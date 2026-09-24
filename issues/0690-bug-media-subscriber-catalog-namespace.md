# Media Subscriber の Catalog 適用が catalogNamespace を渡していない

- Created: 2026-09-24
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-media-subscriber-catalog-namespace
- Polished: 2026-09-24

## 目的

closed の `0647-bug-catalog-required-validation.md` は `applyCatalogDelta` に `options.catalogNamespace` を追加し、draft-ietf-moq-msf-01 §5.2.2 の「track が namespace を宣言しない場合は catalog track の namespace を継承する」を解決したうえで、重複 (§5.2.3) と参照切れ (§5.2.13) を検証する設計にした。しかし delta を適用する唯一の呼び出し元である `src/createMediaSubscriber.ts` は `catalogNamespace` を渡していないため、継承を解決した重複検出が効かない経路が残っている。namespace を宣言しない track と catalog namespace を明示した同名 track が delta の add で混ざっても検出できない。

## 現状

- `src/createMediaSubscriber.ts` の `processCatalogPayload` (203-224 行目) は delta のとき `applyCatalogDelta(current, message)` を第 3 引数なしで呼ぶ (213 行目)
- その呼び出し元は同ファイルの `handleCatalogObject` (1098-1117 行目) で、1102 行目が `processCatalogPayload(this.receivedCatalog, obj.payload)` と payload しか渡さない
- `src/msf/catalogDelta.ts` の `applyCatalogDelta` (40 行目) は `options.catalogNamespace` を受け (43 行目)、`normalizeNamespace` (186-193 行目) で継承を解決した値を次の判定に使う。remove の対象探索 (63 行目 / 69 行目)、clone の親探索 (90 行目 / 93 行目) と clone 名の重複判定 (107-108 行目)、`assertTrackNameUnique` (139 行目)、`assertInitRefResolvable` (143 行目) である
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` (173 行目) は `track.namespace ?? catalogNamespace` で比較する (185 行目)。`catalogNamespace` が undefined のときは namespace 未宣言どうししか衝突とみなさない
- catalog の namespace は `MediaSubscriberImpl` が持っている。catalog の subscribe は `subscribeCatalog` (604 行目) が `this.options.namespace` (609 行目) を使い (641-643 行目)、fetch も同じ値を使う (680-684 行目)。`MediaSubscriberOptions.namespace` は `string[]` (`src/codec/types.ts` 119 行目) である
- 一方 MSF の `CatalogTrack.namespace` は `string` (`src/msf/types.ts` 117 行目)、`RemoveTrack.namespace` も `string` (`src/msf/types.ts` 254 行目) である。MOQT の namespace (byte string の列) と MSF の namespace (文字列) の対応は仕様で定まっていない
- 文字列化の先例は devtools の購読 UI にある。`devtools/src/hooks/useSubscriber.ts` は入力を `settings.namespace.value.split("/")` で配列にし (769 行目)、表示は `namespaceArray.join("/")` とする (1145 行目)
- delta を適用するのは `createMediaSubscriber` だけである。devtools の購読は delta を適用しない (`devtools/src/hooks/useSubscriber.ts` 846-853 行目が「delta apply は createMediaSubscriber 同様、別 issue 対応」と明記する)
- `src/msf.test.ts` の「applyCatalogDelta: catalogNamespace 解決後の配列またぎ重複は reject される (§5.2.2/§5.2.3)」(798 行目) が `catalogNamespace` を渡したときの挙動を固定しているが、`createMediaSubscriber` 経由のテストは無い。`src/createMediaSubscriber.test.ts` の `processCatalogPayload` のテスト (47-93 行目) はすべて 2 引数で呼ぶ
- 0647 の「残した課題」に「parse 時は catalog namespace が未知のため、namespace 未指定の track と明示 namespace の track が継承後に同一になる重複は検出しない (delta 経路は `catalogNamespace` で解決する)」と記録されている。delta 経路の解決は呼び出し元が値を渡して初めて成立する

## 設計方針

- `processCatalogPayload` の第 3 引数に `options?: { catalogNamespace?: string }` を足し、delta のときに `applyCatalogDelta(current, message, options)` へそのまま渡す。`applyCatalogDelta` と同じ形にして新しい概念を増やさない
- `MediaSubscriberImpl` に catalog namespace の文字列を保持する private フィールドを足し、`this.options.namespace` から作る。namespace が空配列のときは undefined にし、従来どおり「両方未宣言どうしの比較」にフォールバックする
- `handleCatalogObject` は `processCatalogPayload(this.receivedCatalog, obj.payload, options)` を呼ぶ。`catalogNamespace` が undefined のときは空 object を渡し、`applyCatalogDelta` の既存の未指定挙動を保つ
- 配列から文字列への対応は仕様に無い実装固有の規約である。devtools の購読 UI と同じ "/" 連結を採用し、JSDoc に「MSF の namespace は文字列、MOQT の namespace は byte string の列であり、対応は仕様で定まっていない。本実装は devtools の購読 UI と同じ "/" 連結を使う」と明記する。`MediaSubscriberOptions.catalogNamespace` で明示できるようにする案は、オプションの追加になるため本 issue では扱わない
- 対象は `src/createMediaSubscriber.ts` (`processCatalogPayload` の引数追加と `handleCatalogObject` の配線、JSDoc) と `src/createMediaSubscriber.test.ts` とする。`src/msf/catalogDelta.ts` と `src/msf/catalogValidation.ts` のシグネチャと挙動は変えない
- namespace を宣言しない track が既存の namespace 明示 track と継承後に同一になる Catalog は、これまで受理していたため破壊的変更になり得る。0647 が受信側の拒否強化を `[CHANGE]` として記録したのと同じ扱いにし、`CHANGES.md` の `## develop` に追記する
- `src/createMediaSubscriber.test.ts` に、`catalogNamespace` を渡した delta の適用で namespace 未宣言の add が継承後の重複として拒否されること、`onError` へ届くこと、`receivedCatalog` が更新されないこと、namespace が空配列なら従来どおり適用されることを固定するテストを追加する

## 完了条件

- `processCatalogPayload` が catalog namespace を受け取り、delta 適用時に `applyCatalogDelta` へ渡す
- namespace を宣言しない track の delta add が、`MediaSubscriberOptions.namespace` を "/" で連結した値と同名の既存 track と衝突した場合、適用が `Error` になり `handleCatalogObject` が `onError` へ通知し、`receivedCatalog` を更新しない
- namespace が空配列の場合は従来どおり namespace 未宣言どうしの重複だけを検出する
- 継承後に重複しない delta は従来どおり適用される
- `applyCatalogDelta` のシグネチャと `assertTrackNameUnique` の挙動が変わらない
- "/" 連結が実装固有の規約であることが `createMediaSubscriber.ts` の該当コードの JSDoc に書かれている
- `CHANGES.md` の `## develop` に `[CHANGE]` が追記されている
- 既存テストが通り、`npx vp check` / `npx vp test --run` が通る

## 参照

- draft-ietf-moq-msf-01 §5.2.2 (track namespace。未宣言なら catalog track の namespace を継承する MUST)。本文は `refs/moq/draft-ietf-moq-msf-01.txt` の 822-831 行目
- draft-ietf-moq-msf-01 §5.2.3 (namespace ごとの track name 一意)。同 832-848 行目
- draft-ietf-moq-msf-01 §5.1.6 (delta update) / §5.3 (delta の適用)。同 647-691 行目 / 1535 行目以降
- closed `0647-bug-catalog-required-validation.md` (`catalogNamespace` の導入と、呼び出し元が値を渡していない状態)
- `devtools/src/hooks/useSubscriber.ts` の namespace の split / join (769 行目 / 1145 行目)

## 解決方法

{未着手}
