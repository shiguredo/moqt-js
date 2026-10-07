/**
 * devtools のビルド元の表記
 *
 * devtools は moqt-js のソースを直接参照してビルドするため、moqt-js の version
 * (`src/version.ts`) は「直近にリリースした版」を指す。develop のビルドでその値を
 * 画面に出すと、リリース済みの版を名乗ってしまう (develop はリリース済みの版より
 * 進んでいる)。そのためフッターでは、実際にビルドした版が分かるこの値を使う。
 *
 * 値はビルド時に devtools/vite.config.ts の define で埋め込まれる。
 * - タグのビルド: タグ名 (例: `2026.2.0`)
 * - それ以外のビルド: ブランチ名と短縮 SHA (例: `develop (fd3e318)`)
 */

declare const __MOQT_DEVTOOLS_BUILD__: string;

/** devtools のビルド元 (例: `develop (fd3e318)` / `2026.2.0`) */
export const buildLabel: string = __MOQT_DEVTOOLS_BUILD__;
