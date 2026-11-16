# connectionURI へ改名し、track-level の token を削除する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 の Table 4 は track フィールドの JSON 名を `connectionURI` と定める (§5.2.37)。draft-01 は `connectionUri` だった。また draft-02 §5.2.42 / §5.2.43 は publish track の認可を `authInfo` で表すこととし、draft-01 §5.2.37 の track-level `token` を廃止した。現行実装は `connectionUri` の綴りで読み書きし、`token` を公開型・検証・変数置換に残している。draft-02 の catalog を送ると `connectionURI` が未知フィールドとして扱われ、publish track の接続先が失われる。

draft-01 との互換性は維持しない。`connectionUri` と `token` は受理しない。

## 現状

- `src/msf/types.ts` の `CatalogTrack` は `connectionUri` と `token` を持たない。`PublishTrack` が `connectionUri?: string` と `token?: string` を持つ
- `src/msf/catalogTrackValidation.ts` の `pickPublishTrackFields` は `connectionUri` と `token` を読む。`KNOWN_TRACK_FIELDS` にも 2 つが入っている
- 同ファイルの `validateCatalogTrack` は `connectionUri` と `token` を publishTracks 専用として扱い、それ以外の source で拒否する
- `src/msf/variables.ts` の `substituteTrack` は `connectionUri` と `token` の両方を置換する
- `src/msf/catalogValidation.ts` の `KNOWN_CATALOG_ROOT_FIELDS` は track フィールドではないため影響しない
- `docs/IMPLEMENTATION_STATUS.md` の Publish Track の節が `connectionUri / token` を対応済みとして挙げている

## 設計方針

- `PublishTrack.connectionUri` を `connectionURI` に改名する。`CatalogTrack` 側に置くか `PublishTrack` 側に残すかは、Table 4 が Track Object のフィールドとして挙げているため `CatalogTrack` に移す
- `token` を型、`KNOWN_TRACK_FIELDS`、`pickPublishTrackFields`、`validateCatalogTrack` の source 判定、`substituteTrack`、docs から削除する
- `connectionURI` の値は MOQT endpoint URI として妥当であることを検証する (§5.2.37)。`src/moqtUri.ts` の URI 解析を使い、`moqt` scheme を持つことを要求する
- `connectionURI` が指定された publish track は、購読側が新しい MOQT 接続を張る対象である。高レベル API がこの接続を張るかは別 issue の範囲とし、本 issue では型・検証・変数置換までを対象にする
- 既存の catalog fixture と devtools の catalog 生成コードを `connectionURI` に追随させる

## 完了条件

- `"connectionURI"` を持つ publish track を decode すると、型付きフィールドに値が入る。単体テストで固定する
- `"connectionUri"` を持つ publish track の値は型付きフィールドに入らない。単体テストで固定する
- `"token"` を持つ track を、publishTracks でもそれ以外でも型付きフィールドに取り込まない。単体テストで固定する
- `moqt` scheme でない `connectionURI` を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
