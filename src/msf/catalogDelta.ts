/**
 * Catalog 差分更新の適用 (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * 参照: draft-ietf-moq-msf-01
 */

import {
  KNOWN_CATALOG_ROOT_FIELDS,
  assertInitRefResolvable,
  assertTrackNameUnique,
} from "./catalogValidation";
import {
  validatePackagingSpecificRules,
  validateRoleSpecificRules,
} from "./catalogTrackValidation";
import type { Catalog, CatalogDelta, CatalogTrack } from "./types";

// =============================================================================
// Catalog 差分更新の適用
// =============================================================================

/**
 * 差分更新を適用して新しい Catalog を作成する
 * (draft-ietf-moq-msf-01 §5.1.6 / §5.3)
 *
 * §5.3: 操作は配列順に逐次適用する。
 * 親 / 削除対象探索キーは `(name, namespace ?? options.catalogNamespace)`
 * のタプル正規化を行う (§5.2.2「If it is not declared within a track, then
 * each track MUST inherit the namespace of the catalog track」)。
 *
 * `options.catalogNamespace` 自体が省略された場合は、両方の namespace が共に
 * 未指定の場合のみ一致とする (従来挙動と互換)。
 *
 * §5.1.3: isComplete は一度設定したら削除禁止 (MUST NOT) のため引き継ぐ。
 *
 * 存在しない remove は throw する (add 重複・clone 親不存在と同一契約)。
 * delta 側の未知ルートフィールドは結果にマージしない
 * (ベース catalog 側の未知のみ引き継ぐ)。
 */
export function applyCatalogDelta(
  current: Catalog,
  delta: CatalogDelta,
  options?: { catalogNamespace?: string },
): Catalog {
  const catalogNamespace = options?.catalogNamespace;
  let tracks = [...current.tracks];

  // §5.1.3: isComplete=true は「これ以降 track 追加・更新・新コンテンツ発行を行わない」コミットメント。
  // 確定後の catalog に add/clone operation を含む delta を適用するのは MUST 違反。remove のみ許容する。
  if (current.isComplete === true) {
    for (const operation of delta.operations) {
      if (operation.type === "add" || operation.type === "clone") {
        throw new Error(
          `invalid catalog delta: cannot ${operation.type} tracks after isComplete=true per §5.1.3`,
        );
      }
    }
  }

  for (const operation of delta.operations) {
    if (operation.type === "remove") {
      for (const removeTrack of operation.tracks) {
        const targetNs = normalizeNamespace(removeTrack.namespace, catalogNamespace);
        const before = tracks.length;
        tracks = tracks.filter((track) => {
          if (track.name !== removeTrack.name) {
            return true;
          }
          const trackNs = normalizeNamespace(track.namespace, catalogNamespace);
          return trackNs !== targetNs;
        });
        // 存在しない remove は typo のため add 重複・clone 親不存在と同様に throw する
        if (tracks.length === before) {
          const target =
            removeTrack.namespace === undefined
              ? `name='${removeTrack.name}'`
              : `name='${removeTrack.name}', namespace='${removeTrack.namespace}'`;
          throw new Error(`invalid catalog delta: remove track not found, ${target}`);
        }
      }
    } else if (operation.type === "add") {
      tracks = [...tracks, ...operation.tracks];
    } else if (operation.type === "clone") {
      for (const cloneTrack of operation.tracks) {
        if (!cloneTrack.parentName) {
          throw new Error(
            `invalid catalog delta: clone track missing parentName per §5.1.6 / §5.2.33`,
          );
        }
        const parentNs = normalizeNamespace(cloneTrack.parentNamespace, catalogNamespace);
        const baseTrack = tracks.find((t) => {
          if (t.name !== cloneTrack.parentName) return false;
          const trackNs = normalizeNamespace(t.namespace, catalogNamespace);
          return trackNs === parentNs;
        });
        if (!baseTrack) {
          throw new Error(
            `invalid catalog delta: clone track parent not found, parentName='${cloneTrack.parentName}'`,
          );
        }
        // ベーストラックをコピーして cloneTrack のプロパティで上書き。
        // parentName / parentNamespace はクローン後トラックには含めない。
        const { parentName: _pn, parentNamespace: _pns, ...cloneProps } = cloneTrack;
        const cloned: CatalogTrack = { ...baseTrack, ...cloneProps };
        // §5.1.6 "clone": The cloned track inherits all attributes from the parent except
        // the Track Name which MUST be new. parent と同じ (name, namespace) は新規でないので reject。
        const clonedNs = normalizeNamespace(cloned.namespace, catalogNamespace);
        const baseNs = normalizeNamespace(baseTrack.namespace, catalogNamespace);
        if (cloned.name === baseTrack.name && clonedNs === baseNs) {
          throw new Error(
            `invalid catalog delta: clone track name '${cloned.name}' must differ from parent name per §5.1.6`,
          );
        }
        // §5.2.8 / §5.2.9: targetLatency と buffers の併存禁止。
        // clone で base から継承した一方を override せず他方を追加すると併存する。
        if (cloned.targetLatency !== undefined && cloned.buffers !== undefined) {
          throw new Error(
            `invalid catalog delta: cloned track '${cloned.name}' has both targetLatency and buffers per §5.2.8 / §5.2.9`,
          );
        }
        // §7.2 / §8.2: packaging 別の MUST 検証も clone 結果に対して再実行する。
        // 「base.packaging を継承 + 必須フィールドも継承」「clone で packaging を override + 必須を新規」
        // のどちらでも結果は MUST を満たす必要がある。validateCloneCatalogTrack は merge 前に
        // skipPackagingRequiredFields=true で skip しているため、ここで合成後を検証する。
        if (cloned.packaging !== undefined) {
          validatePackagingSpecificRules(cloned, cloned.packaging, cloned.name);
        }
        // §5.2.18 / §5.2.22 / §5.2.28 / §5.2.29: role 条件付き MUST も合成後に
        // 再実行する (base から role を継承し必須フィールドを持たない clone を検出する)。
        validateRoleSpecificRules(cloned, cloned.name);
        tracks.push(cloned);
      }
    }
  }

  // §5.2.3: 全 operation 適用後の tracks と (引き継いだ) publishTracks をまとめて
  // (name, namespace) uniqueness を再検証する。delta 経由でも配列をまたぐ重複を
  // 残さないため、publishTracks は下で合成する result ではなく current から渡す。
  assertTrackNameUnique(tracks, current.publishTracks, catalogNamespace);

  // §5.2.13: initRef の参照切れも合成後に検証する (delta の add / clone が
  // initDataList に無い参照を持ち込むと、validateCatalog の拒否する Catalog になる)
  assertInitRefResolvable(tracks, current.publishTracks, current.initDataList);

  // §5.3 / §5.1.1: delta update に version は含まれない (MUST NOT)。current.version をそのまま維持する。
  const result: Catalog = {
    version: current.version,
    tracks,
  };
  const mergedGeneratedAt = delta.generatedAt ?? current.generatedAt;
  if (mergedGeneratedAt !== undefined) {
    result.generatedAt = mergedGeneratedAt;
  }

  if (current.isComplete === true) {
    result.isComplete = true;
  }
  if (current.publishTracks !== undefined) {
    result.publishTracks = current.publishTracks;
  }
  if (current.initDataList !== undefined) {
    result.initDataList = current.initDataList;
  }

  // root level の未知フィールドをベース catalog から引き継ぐ（§5 保持解釈）。
  // delta 側の未知は結果にマージしない (適用は tracks 中心であり、delta 未知の
  // 引き継ぎ規則は未定義のため。decode → encode の round-trip では保持される)。
  const currentRecord = current as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      resultRecord[key] = currentRecord[key];
    }
  }

  return result;
}

/**
 * `(track.namespace, catalogNamespace)` を解決し、比較用の正規化値を返す。
 *
 * - `track.namespace` が明示指定されていれば、その値を使う。
 * - `track.namespace` が未指定で `catalogNamespace` が指定されていれば、後者を使う。
 * - 両方未指定なら `undefined`。
 */
function normalizeNamespace(
  trackNamespace: string | undefined,
  catalogNamespace: string | undefined,
): string | undefined {
  if (trackNamespace !== undefined) return trackNamespace;
  if (catalogNamespace !== undefined) return catalogNamespace;
  return undefined;
}
