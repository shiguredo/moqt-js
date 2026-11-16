# depends の renderGroup 参照と timeline の catalog 要件を draft-02 にする

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 は `depends` の要素に track 名 (JSON String) と renderGroup (JSON Number) の両方を許し、すべての要素が解決することを MUST とする。また §7.2 と §8.3 から `mimeType="application/json"` の必須を撤廃し、Event Timeline の `depends` は index が media timeline track を参照する場合だけ MUST にした。現行実装は逆の挙動で、draft-02 の正しい catalog を拒否する。

## 現状

- `src/msf/types.ts` の `CatalogTrack.depends` は `string[]` で、Number 要素を持てない
- `src/msf/catalogTrackValidation.ts` の `pickDependsAndTemplate` は `depends` の全要素が string であることを要求し、Number を拒否する
- `src/msf/variables.ts` の `substituteTrack` は `depends` を文字列配列として走査する
- 同ファイルの `validatePackagingSpecificRules` は `mediatimeline` と `eventtimeline` の両方で `mimeType === "application/json"` を必須にする
- 同じ関数が `eventtimeline` で `depends` を無条件に必須にする
- `depends` の参照先が存在するかどうかを catalog 全体で検証する処理が無い。参照切れの `depends` を受理する
- 同ファイルの `validateRoleSpecificRules` は role が `video` / `audio` のとき `codec` と `bitrate` を必須にするが、§5.2.4.1 Table 6 が追加で求める `framerate` などを要求していない

## 設計方針

- `CatalogTrack.depends` を `readonly (string | number)[]` にする。String は Track Name、Number は renderGroup を指す
- `pickDependsAndTemplate` で要素の型を String と Number の 2 種類に限定し、それ以外を拒否する
- `substituteTrack` は String 要素だけを変数置換の対象にし、Number 要素はそのまま通す
- `catalogValidation.ts` に `depends` の解決検証を追加する。`assertTrackNameUnique` と同じ層で catalog 全体を見る。String は catalog 内の track の Track Name と完全一致すること、Number は catalog 内の track の `renderGroup` と一致することを要求する。`publishTracks` も対象に含める
- `validatePackagingSpecificRules` から `mimeType` の必須検証を削除する。`mimeType` 自体は任意フィールドとして受理を続ける
- `eventtimeline` の `depends` 必須を削除する。代わりに「`depends` があるとき、その String 要素が media timeline track を指すなら、その track が `packaging: "mediatimeline"` であること」を検証する。index が media timeline を参照しているかは payload を見ないと分からないため、track 定義だけで判定できる範囲に限定する
- §5.2.4.1 Table 6 の (packaging, role) 必須フィールドを実装する。`loc` + `video` は `codec`、`bitrate`、`framerate`、`loc` + `audio` は `codec`、`bitrate`、`samplerate`、`channelConfig`、`loc` + `audiodescription` は `codec`、`samplerate`、`channelConfig`、`lang`、`loc` + `signlanguage` は `codec`、`framerate`、`eventtimeline` + `eventtimeline` は `eventType` を要求する
- 既存の `validateRoleSpecificRules` と `validateAudioCodecRules` の条件は §5.2.19 / §5.2.23 / §5.2.29 / §5.2.30 の条件付き MUST に対応するため残す。Table 6 の検証は packaging が `loc` のときに限る

## 完了条件

- `"depends": [1]` を含む `mediatimeline` の track を受理する。単体テストで固定する
- `"depends": [99]` のように解決しない renderGroup を参照する catalog を拒否する。単体テストで固定する
- `"depends": ["no-such-track"]` を拒否する。単体テストで固定する
- `mimeType` を持たない `mediatimeline` と `eventtimeline` を受理する。単体テストで固定する
- `depends` を持たない `eventtimeline` を受理する。単体テストで固定する
- Table 6 の各行について、必須フィールドを欠く track を拒否する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/types.ts` の `CatalogTrack.depends` を `readonly (string | number)[]` にした
- `src/msf/catalogTrackValidation.ts` の `pickDependsAndTemplate` で String と Number だけを受理するようにし、`validatePackagingSpecificRules` から `mimeType` の必須検証と `eventtimeline` の `depends` 無条件必須を削除した
- 同ファイルに `validateRequiredFieldsPerPackagingAndRole` を追加し、§5.2.4.1 Table 6 の (packaging, role) 必須フィールドを検証する。既存の条件付き MUST の後に呼び、エラー文言の順序を保つ
- `src/msf/catalogValidation.ts` に `assertDependsResolvable` を追加した。String は自 track 以外で Track Name が一致する track がちょうど 1 つ、Number はその renderGroup を宣言する track が存在することを要求する。変数を含む要素は置換前のため対象外にする
- `validateCatalog` と `applyCatalogDelta` から `assertDependsResolvable` を呼ぶようにした
- `src/msf/variables.ts` の変数置換は `depends` の String 要素だけを対象にした
- `src/msf.prop.ts` の arbitrary が Table 6 の必須フィールドを補うようにした
