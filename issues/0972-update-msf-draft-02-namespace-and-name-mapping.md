# catalog の namespace を / 区切りにし、名前マッピングを実装する

- Created: 2026-11-16
- Completed: {YYYY-MM-DD}
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.2.2 は catalog の `namespace` を `/` で区切った 1 つの JSON 文字列と定義し、1〜32 個の非空フィールドを要求する。malformed な値は catalog を invalid にする。また §11.2 が新設され、catalog の文字列を MOQT のバイト列へ変換する規則 (UTF-8、正規化なし、孤立サロゲートと NUL の禁止、BOM 禁止、バイト完全一致比較) を初めて規範的に定めた。

現行実装は `namespace` を不透明な文字列として保持し、形式を検証しない。空の Track Name も受理する。catalog document は非 fatal な `TextDecoder` で読むため、BOM を除去し、不正な UTF-8 を U+FFFD に置換し、孤立サロゲートと NUL をそのまま通す。購読時は catalog の `namespace` を使わず、常に `createMediaSubscriber` の `namespace` オプションで SUBSCRIBE する。

## 現状

- `src/msf/types.ts` の `CatalogTrack.namespace` は `string` で、区切りの意味を持たない
- `src/msf/catalogTrackValidation.ts` の `pickIdentityFields` は `namespace` の型だけを見て、`/` 区切りの妥当性を検証しない
- 同ファイルの `buildValidatedCatalogTrack` は `name` の型だけを見て、空文字列を拒否しない
- `src/msf/catalogValidation.ts` の `assertTrackNameUnique` は `namespace` を文字列キーとして使い、catalog namespace の継承を `catalogNamespace` 引数で解決する
- `src/msf/catalogDelta.ts` の `normalizeNamespace` も同じく文字列比較である
- `src/msf/catalogCodec.ts` の `decodeCatalogMessage` は `new TextDecoder()` で bytes を文字列にする。fatal でも BOM 検査でもない
- `src/msf/variables.ts` の `substituteTrack` は `namespace` を文字列として置換する
- `src/mediaSubscriber/catalogSubscription.ts` と `src/createMediaSubscriber.ts` は catalog の track を解決するときに `track.namespace` を参照せず、`this.options.namespace` で SUBSCRIBE する
- `src/fullTrackName.ts` の `fullTrackNameKey` は UTF-16 のコードユニット数で長さ付きキーを作る。孤立サロゲートを含む 2 つの名前が同じキーになり得る

## 設計方針

- `CatalogTrack.namespace` を `/` 区切りの文字列のまま保持するか、`readonly string[]` に分割して保持するかを決める。分割して保持する案では、decode で `/` を分割し、encode で `/` で連結する。どちらを選んでも、`/` が 1〜32 個の非空フィールドを作ることを検証する
- 検証は `catalogTrackValidation.ts` に置く。空文字列、先頭と末尾の `/`、連続する `/`、33 個以上のフィールドを拒否する。`name` が空文字列の場合は拒否する
- 継承と一意性の比較は、分割後のフィールド列で行う。`assertTrackNameUnique` と `normalizeNamespace` は文字列連結ではなくフィールド列をキーにする
- `decodeCatalogMessage` を strict にする。`TextDecoder` に `{ fatal: true }` を渡し、先頭の BOM を明示的に拒否する (`ignoreBOM` を true にして BOM を文字として残すか、bytes の先頭 3 バイトを検査する)
- `name`、`namespace`、`depends` の String 要素、`parentName`、`parentNamespace` を対象に、孤立サロゲート (U+D800〜U+DFFF) と U+0000 を拒否する検証を追加する
- 購読時に catalog の `namespace` を使う。track が `namespace` を宣言していればその値で SUBSCRIBE し、宣言していなければ catalog を購読した namespace (カタログ自身の namespace) を継承する。`createMediaSubscriber` の `namespace` オプションは catalog の購読先を決める値であり、track の namespace 解決には catalog の namespace を優先する
- `fullTrackNameKey` を UTF-8 バイト列ベースにする。孤立サロゲートを拒否する検証を入口に入れるため、キーの衝突は起きにくくなるが、§11.2.3 の「MOQT から受けた名前は raw バイトで比較する」を満たすにはバイト列でのキー生成が必要になる

## 完了条件

- `"namespace": "conference.example.com/conference123/alice"` を 3 フィールドとして扱い、catalog を受理する。単体テストで固定する
- 空文字列、`"a//b"`、`"/a"`、`"a/"`、33 フィールドの `namespace` を拒否する。単体テストで固定する
- 空文字列の `name` を拒否する。単体テストで固定する
- 孤立サロゲートと NUL を含む `name` / `namespace` を拒否する。単体テストで固定する
- BOM で始まる catalog document と、不正な UTF-8 バイト列を含む catalog document を拒否する。単体テストで固定する
- `namespace` を宣言した track を、その namespace で SUBSCRIBE する。単体テストで固定する
- `namespace` を宣言しない track を、catalog の namespace を継承して SUBSCRIBE する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る
