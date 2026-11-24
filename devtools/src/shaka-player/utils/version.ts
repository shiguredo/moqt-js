const SHAKA_PLAYER_REPOSITORY = "https://github.com/shaka-project/shaka-player";
const SHAKA_PLAYER_PACKAGE = "https://www.npmjs.com/package/shaka-player";

export interface ShakaVersionInfo {
  /** リリースタグ。バージョンが解析できないときは入力そのもの。 */
  displayVersion: string;
  /** タグからの経過を表す main-13-gef7e1bf63 のような接尾辞。無ければ null。 */
  detail: string | null;
  /** リリースタグのページ。解析できないときはリポジトリ。 */
  releaseUrl: string;
  /** ビルドした commit のページ。commit が分からなければ null。 */
  commitUrl: string | null;
  /** shaka-player の npm パッケージ。 */
  packageUrl: string;
}

/**
 * shaka.Player.version の git describe 形式を、リンク先と表示用に分解する。
 *
 * shaka の experimental build は、タグ v5.3.6 の 13 commit 後なら
 * `v5.3.6-main-13-gef7e1bf63` のような値になる。タグ自体と、実際にビルドした
 * commit の両方をリンクできるようにする。
 */
export function describeShakaVersion(version: string): ShakaVersionInfo {
  const match = /^(v?\d+\.\d+\.\d+)(?:-(.+)-(\d+)-g([0-9a-f]+))?$/i.exec(version);
  if (match === null) {
    return {
      displayVersion: version,
      detail: null,
      releaseUrl: SHAKA_PLAYER_REPOSITORY,
      commitUrl: null,
      packageUrl: SHAKA_PLAYER_PACKAGE,
    };
  }

  const displayVersion = match[1] ?? version;
  const branch = match[2] ?? null;
  const count = match[3] ?? null;
  const commit = match[4] ?? null;
  const releaseTag = displayVersion.startsWith("v") ? displayVersion : `v${displayVersion}`;
  return {
    displayVersion,
    detail:
      branch !== null && count !== null && commit !== null ? `${branch}-${count}-g${commit}` : null,
    releaseUrl: `${SHAKA_PLAYER_REPOSITORY}/releases/tag/${releaseTag}`,
    commitUrl: commit === null ? null : `${SHAKA_PLAYER_REPOSITORY}/commit/${commit}`,
    packageUrl: SHAKA_PLAYER_PACKAGE,
  };
}
