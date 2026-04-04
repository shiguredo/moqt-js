# MSF カタログ差分の適用順が仕様と一致しない

Created: 2026-04-04
Model: Composer 2 Fast

## なぜこの対応が必要か

`applyCatalogDelta` は `removeTracks` → `addTracks` → `cloneTracks` の固定順で処理している。一方、[draft-ietf-moq-msf-00 §5.2](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.2) では Add / Delete / Clone 操作は **JSON ドキュメント内の宣言順** に逐次適用されるとある。

> "The Add, Delete and Clone operations are applied sequentially in the order they are declared in the document."

宣言順が remove より先に add がある場合など、実装結果が仕様と食い違う。

## 修正範囲の前提（受け入れ条件のため必須）

`applyCatalogDelta` の適用順だけを直す記述にすると、**修正範囲が足りない**。

現状の `CatalogDelta` 型（`src/msf.ts`）は `addTracks` / `removeTracks` / `cloneTracks` を **別フィールドの配列**として持っており、JSON オブジェクト内の **キー宣言順に相当する「操作の全順序」** を表現していない。また `decodeCatalogMessage` は `JSON.parse` の結果をそのまま型に載せるだけで、**宣言順の操作列を保持するデコード方針ではない**。

本 issue は [§5.2](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.2) との差分を **bug** として起票している。**完了（クローズ）条件**は、§5.2 の「宣言順に逐次適用」と **結果が整合する実装**に到達することである。README やコメントで「当ライブラリは宣言順非対応」と書くだけでは **不一致は解消されない**。そのような文書化は補助であり、**この issue の完了条件に含めない**。

仕様に合わせるための実装案の例（いずれも **挙動**を変えるもの）:

- デルタを **単一の操作配列**（例: タグ付き union の列）として表現するデータモデルへの変更と、それに合わせた `decodeCatalogMessage` / `applyCatalogDelta`
- JSON の **キー順を操作順として保持する** デコード方針（実装・互換・オブジェクトキー順の扱いへの注意）

採用する案は PR または本 issue の更新で明示すること。

## 参照

- 実装: `src/msf.ts` の `CatalogDelta`、`decodeCatalogMessage`、`applyCatalogDelta`
- 仕様: [draft-ietf-moq-msf-00 §5.2 Delta updates](https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-00#section-5.2)

## 優先度

確認済み一覧の 1 位（issue 候補 A）。
