# catalog を参照する catalog と catalog object の規則を実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5 は、top-level の catalog track 名を `"catalog"` に固定したまま、catalog が別の catalog を参照できるようにした。Table 5 の packaging に `catalog` が追加され、参照先の track は `packaging: "catalog"` で表す。§5.6.16 に別 namespace の catalog を参照する例がある。また §5 は catalog object のマッピングを MUST で定めた。すべての catalog object は Subgroup 0 に載せ、Group 内の Object ID 0 は independent な catalog、Object ID 1 以上は delta update とし、independent を生成したら新しい Group の先頭に置く。catalog track は配下の track より高い publisher priority を SHOULD とし、購読はより高い subscriber priority を SHOULD とする。

現行実装は `catalog` packaging を型に持たず、参照先 catalog を解決しない。catalog object の Group と Object ID の規則も購読側で検証しない。catalog の publisher priority は Object 単位で 0 を指定しているが、track 既定は未指定のままで、映像キーフレームも 0 のため「配下のすべての track より高い」状態ではない。購読側は subscriber priority を指定していない。

## 現状

- `src/msf/version.ts` の `PackagingType` は `"loc" | "mediatimeline" | "eventtimeline" | "moqlog" | "moqmetrics"` で、`"catalog"` を持たない。ただし `validateCatalogTrack` は packaging の値を集合で検証しないため、実行時には任意の文字列を受理する
- `src/msf/catalogValidation.ts` の `validateCatalogTrack` は packaging を `PackagingType` に cast するだけで、Table 5 の値集合を検査しない
- `src/mediaSubscriber/catalogSubscription.ts` は受信した catalog object を Object ID や Group ID で検証せず、届いた順に適用する
- `src/createMediaPublisher.ts` は catalog Object を `priority: PRIORITY_CATALOG` (0) で送るが、track の publisher priority を指定しない
- `src/mediaSubscriber/catalogSubscription.ts` は `session.subscribe` に `subscriberPriority` を渡さない
- 参照先 catalog を購読する経路は無い

## 設計方針

- `PackagingType` に `"catalog"` を追加し、`validateCatalogTrack` で packaging が Table 5 の値集合に含まれることを検証する。未知の packaging を拒否する
- catalog object の規則を購読側で検証する。Subgroup 0 以外で届いた catalog object を不正として扱う。Group 内の Object ID 0 が delta update だった場合を不正として扱う。independent な catalog を受けたら、それ以前の Group の delta は適用しない
- catalog の publisher priority を track 単位で指定する。配下の track の publisher priority より数値が小さくなるようにする。映像キーフレームと同じ 0 では「より高い」と言えないため、メディア track の既定 priority を見直すか、catalog 専用の値を使う
- catalog の購読に `subscriberPriority` を指定する。他の購読より高い優先度にする
- `packaging: "catalog"` の track を検出したら、参照先 catalog の扱いを決める。本 issue では「型・検証・検出までを実装し、参照先の自動購読は行わない」とし、利用者に参照先 catalog の情報を渡す API を追加する。自動購読は別 issue にする
- `packaging: "catalog"` の track は §5.2.4.1 の必須フィールド表に無いため、`name`、`packaging`、`isLive` だけを要求する

## 完了条件

- `packaging: "catalog"` の track を受理し、`PackagingType` に含まれる。単体テストで固定する
- Table 5 に無い packaging 値の track を拒否する。単体テストで固定する
- Subgroup 0 以外で届いた catalog object を不正として扱う。単体テストで固定する
- Group の Object ID 0 が delta update だった場合を不正として扱う。単体テストで固定する
- catalog の publisher priority が配下の track より高く、購読の subscriber priority が他の購読より高い。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
