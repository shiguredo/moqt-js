const SHAKA_PLAYER_REPOSITORY = "https://github.com/shaka-project/shaka-player";
const SHAKA_PLAYER_PACKAGE = "https://www.npmjs.com/package/shaka-player";

export interface ShakaVersionInfo {
  /** リリースタグ。バージョンが解析できないときは入力そのもの。 */
  displayVersion: string;
  /** リリースタグのページ。解析できないときはリポジトリ。 */
  releaseUrl: string;
  /** shaka-player の npm パッケージ。 */
  packageUrl: string;
}

/**
 * shaka.Player.version の git describe 形式から、表示するリリースタグを求める。
 *
 * experimental build は `v5.3.6-main-13-gef7e1bf63` のような値になる。
 * 画面にはタグの `v5.3.6` だけを出し、tag から何 commit 進んでいるかは出さない。
 */
export function describeShakaVersion(version: string): ShakaVersionInfo {
  const match = /^(v?\d+\.\d+\.\d+)(?:-|$)/.exec(version);
  if (match === null) {
    return {
      displayVersion: version,
      releaseUrl: SHAKA_PLAYER_REPOSITORY,
      packageUrl: SHAKA_PLAYER_PACKAGE,
    };
  }

  const displayVersion = match[1] ?? version;
  const releaseTag = displayVersion.startsWith("v") ? displayVersion : `v${displayVersion}`;
  return {
    displayVersion,
    releaseUrl: `${SHAKA_PLAYER_REPOSITORY}/releases/tag/${releaseTag}`,
    packageUrl: SHAKA_PLAYER_PACKAGE,
  };
}
