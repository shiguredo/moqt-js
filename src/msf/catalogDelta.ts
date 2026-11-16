/**
 * Catalog 差分更新の適用 (draft-ietf-moq-msf-02 §5.1.6 / §5.3)
 *
 * 参照: draft-ietf-moq-msf-02
 */

import {
  KNOWN_CATALOG_ROOT_FIELDS,
  assertAccessibleWindowConsistent,
  assertDependsResolvable,
  assertInitRefResolvable,
  assertTrackNameUnique,
} from "./catalogValidation";
import {
  validateAudioCodecRules,
  validatePackagingSpecificRules,
  validateRequiredFieldsPerPackagingAndRole,
  validateRoleSpecificRules,
} from "./catalogTrackValidation";
import { MSF_PACKAGING_VALUES } from "./version";
import { setOwnField } from "./ownFields";
import type { Catalog, CatalogDelta, CatalogTrack } from "./types";

// =============================================================================
// Catalog 差分更新の適用
// =============================================================================

/**
 * 差分更新を適用して新しい Catalog を作成する
 * (draft-ietf-moq-msf-02 §5.1.6 / §5.3)
 *
 * §5.3: 操作は配列順に逐次適用する。各操作は直前までの結果に対して適用し、結果が次の
 * 操作の対象になる。そのため「追加時点で未登録か」「削除時点で存在するか」を操作ごとに判定する。
 *
 * §5.3: any illogical update operation, such as adding an existing name, removing or
 * updating an unknown track or cloning to an existing name MUST be rejected as an
 * invalid catalog.
 *
 * 親 / 削除対象探索キーは `(name, namespace ?? options.catalogNamespace)`
 * のタプル正規化を行う (§5.2.2「If it is not declared within a track, then
 * each track MUST inherit the namespace of the catalog track」)。
 *
 * `options.catalogNamespace` 自体が省略された場合は、両方の namespace が共に
 * 未指定の場合のみ一致とする。
 *
 * §5.1.3: isComplete は一度設定したら削除禁止 (MUST NOT) のため引き継ぐ。
 * isComplete 確定後の add / clone は track を増やすため拒否する。
 *
 * delta 側の未知ルートフィールドは §5.3 が MUST NOT とするため結果にマージしない
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
  // 確定後の catalog に add/clone operation を含む delta を適用するのは MUST 違反。remove と update は
  // track を増やさないため許容する。
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
        // §5.3: removing a track that has not been declared is an illogical operation
        if (tracks.length === before) {
          const target =
            removeTrack.namespace === undefined
              ? `name='${removeTrack.name}'`
              : `name='${removeTrack.name}', namespace='${removeTrack.namespace}'`;
          throw new Error(`invalid catalog delta: remove track not found, ${target}`);
        }
      }
    } else if (operation.type === "add") {
      for (const addTrack of operation.tracks) {
        // §5.3: adding a track that has already been declared is an illogical operation。
        // 操作を逐次適用するため、delta 全体の適用後ではなく追加のたびに判定する
        assertFullTrackNameAbsent(
          tracks,
          addTrack,
          catalogNamespace,
          `add track '${addTrack.name}'`,
        );
        tracks.push(addTrack);
      }
    } else if (operation.type === "clone") {
      for (const cloneTrack of operation.tracks) {
        if (!cloneTrack.parentName) {
          throw new Error(
            `invalid catalog delta: clone track missing parentName per §5.1.6 / §5.2.34`,
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
        // §5.3: cloning to a name that has already been declared is an illogical operation
        assertFullTrackNameAbsent(tracks, cloned, catalogNamespace, `clone track '${cloned.name}'`);
        // §5.2.9 / §5.2.10: targetLatency と buffers の併存禁止。
        // clone で base から継承した一方を override せず他方を追加すると併存する。
        if (cloned.targetLatency !== undefined && cloned.buffers !== undefined) {
          throw new Error(
            `invalid catalog delta: cloned track '${cloned.name}' has both targetLatency and buffers per §5.2.9 / §5.2.10`,
          );
        }
        revalidateMergedTrack(cloned);
        assertLiveTransitionAllowed(baseTrack, cloned);
        tracks.push(cloned);
      }
    } else if (operation.type === "update") {
      for (const updateTrack of operation.tracks) {
        const parentNs = normalizeNamespace(updateTrack.parentNamespace, catalogNamespace);
        const index = tracks.findIndex((track) => {
          if (track.name !== updateTrack.parentName) return false;
          const trackNs = normalizeNamespace(track.namespace, catalogNamespace);
          return trackNs === parentNs;
        });
        const baseTrack = tracks[index];
        if (index === -1 || baseTrack === undefined) {
          throw new Error(
            `invalid catalog delta: update track not found, parentName='${updateTrack.parentName}'`,
          );
        }
        // §5.1.6 "update": Attributes declared in the track object override existing values.
        // parentName / parentNamespace は更新対象の識別に使うので、結果の track には含めない。
        const { parentName: _pn, parentNamespace: _pns, ...overrides } = updateTrack;
        const updated: CatalogTrack = { ...baseTrack, ...overrides };
        // §5.2.9 / §5.2.10: update で一方を上書きして他方が残ると併存する
        if (updated.targetLatency !== undefined && updated.buffers !== undefined) {
          throw new Error(
            `invalid catalog delta: updated track '${updated.name}' has both targetLatency and buffers per §5.2.9 / §5.2.10`,
          );
        }
        revalidateMergedTrack(updated);
        assertLiveTransitionAllowed(baseTrack, updated);
        tracks[index] = updated;
      }
    } else {
      // 手組みの CatalogDelta を渡す経路では wire の decode を通らないため、未知の
      // operation を黙って無視すると「適用したつもりで何も変わらない」catalog を返す
      throw new Error(
        `invalid catalog delta: unknown operation type '${String((operation as { type?: unknown }).type)}' per §5.1.6`,
      );
    }
  }

  // §5.2.3: 全 operation 適用後の tracks と (引き継いだ) publishTracks をまとめて
  // (name, namespace) uniqueness を再検証する。delta 経由でも配列をまたぐ重複を
  // 残さないため、publishTracks は下で合成する result ではなく current から渡す。
  assertTrackNameUnique(tracks, current.publishTracks, catalogNamespace);

  // §5.2.15: depends の参照先の解決も合成後に検証する (delta が参照を壊す場合がある)
  assertDependsResolvable(tracks, current.publishTracks);

  // §5.2.45: altGroup 内の accessibleWindowTime の一致も合成後に検証する
  assertAccessibleWindowConsistent(tracks, current.publishTracks);

  // §5.1.7 / §5.2.14: initRef の参照切れも合成後に検証する (delta の add / clone が
  // initDataList に無い参照を持ち込むと、validateCatalog の拒否する Catalog になる)
  assertInitRefResolvable(tracks, current.publishTracks, current.initDataList);

  // §5.3 / §5.1.1: delta update に version は含まれない (MUST NOT)。current.version をそのまま維持する。
  const result: Catalog = {
    version: current.version,
    tracks,
    generatedAt: delta.generatedAt,
  };

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
  // delta 側の未知フィールドは §5.3 が MUST NOT とするため保持しない。
  const currentRecord = current as unknown as Record<string, unknown>;
  const resultRecord = result as unknown as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    if (!KNOWN_CATALOG_ROOT_FIELDS.has(key)) {
      setOwnField(resultRecord, key, currentRecord[key]);
    }
  }

  return result;
}

/**
 * delta の Full Track Name が未登録であることを確かめる
 *
 * draft-02 §5.3 は「adding an existing name」「cloning to an existing name」を illogical
 * operation として catalog の拒否を MUST とする。操作は逐次適用するため、delta 全体の
 * 適用後ではなく各操作の適用時に判定する。
 *
 * @throws Error 同じ Full Track Name が既に登録されているとき
 */
function assertFullTrackNameAbsent(
  tracks: readonly CatalogTrack[],
  track: Pick<CatalogTrack, "name" | "namespace">,
  catalogNamespace: string | undefined,
  context: string,
): void {
  const targetNs = normalizeNamespace(track.namespace, catalogNamespace);
  const exists = tracks.some(
    (t) => t.name === track.name && normalizeNamespace(t.namespace, catalogNamespace) === targetNs,
  );
  if (exists) {
    throw new Error(`invalid catalog delta: ${context} already exists in the catalog per §5.3`);
  }
}

/**
 * §5.2.8 の isLive 遷移を検証する
 *
 * §5.2.8: A True value MUST never follow a False value.
 * clone / update で親の isLive を false から true に変える delta を拒否する。
 * 新規 add は比較対象の base が無いため、この関数の対象外である。
 *
 * @param base - 変更前の track
 * @param merged - 合成後の track
 * @throws Error false から true に変わるとき
 */
function assertLiveTransitionAllowed(base: CatalogTrack, merged: CatalogTrack): void {
  if (!base.isLive && merged.isLive) {
    throw new Error(
      `invalid catalog delta: track '${merged.name}' must not change isLive from false to true per §5.2.8`,
    );
  }
}

/**
 * 合成後の track に対して条件付き MUST を再検証する
 *
 * clone / update は親から属性を継承するため、delta 単体では packaging / role / codec の
 * 組み合わせが決まらない。合成後の値で draft-02 の MUST を満たすことを確かめる。
 */
function revalidateMergedTrack(track: CatalogTrack): void {
  // §5.2.36: trackDuration は isLive が true のとき MUST NOT
  if (track.isLive && track.trackDuration !== undefined) {
    throw new Error(
      `invalid catalog delta: track '${track.name}' must not include trackDuration when isLive is true per §5.2.36`,
    );
  }
  // §5.2.4 Table 5: packaging の値集合。clone / update は packaging を差し替えられるため、
  // 合成後の値でも受理できることを確かめる
  if (!MSF_PACKAGING_VALUES.has(track.packaging)) {
    throw new Error(
      `invalid catalog delta: track '${track.name}' has packaging '${track.packaging}' not defined in Table 5 per §5.2.4`,
    );
  }
  // §5.2.5 / §7.2 / §8.3 / §9.4 / §10.4: packaging 別の MUST
  validatePackagingSpecificRules(track, track.packaging, track.name);
  // §5.2.4.1 Table 6: (packaging, role) ごとの必須フィールド。clone / update が role や
  // packaging を変えると必須の組み合わせが変わるため、合成後にも検証する
  validateRequiredFieldsPerPackagingAndRole(track, track.packaging, track.name);
  // §5.2.19 / §5.2.23: role 条件付き MUST
  validateRoleSpecificRules(track, track.name);
  // §5.2.29 / §5.2.30: audio codec を持つ track の MUST
  validateAudioCodecRules(track, track.name);
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
