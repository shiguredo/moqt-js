/**
 * Catalog track の検証 (draft-ietf-moq-msf-01 §5.2 / §7.2 / §8.2 / §9.4 / §10.4)
 *
 * 既知フィールドを pick しつつ §5.2 の MUST / MUST NOT を検証し、packaging 別の
 * MUST は validatePackagingSpecificRules が担う。
 *
 * 参照: draft-ietf-moq-msf-01
 */

import { toMsfLocationBigInt } from "./json";
import type { PackagingType } from "./version";
import type {
  AccessibilityDescriptor,
  AuthInfo,
  Buffers,
  CatalogTrack,
  MediaTimelineTemplate,
  PublishTrack,
} from "./types";

/**
 * CatalogTrack の既知フィールド名（§5.2）。未知フィールド保持時に除外するために使う。
 * name / packaging / isLive は呼び出し側で検証済み、parentName / parentNamespace は clone 経路。
 */
export const KNOWN_TRACK_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "packaging",
  "isLive",
  "namespace",
  "role",
  "label",
  "eventType",
  "targetLatency",
  "buffers",
  "renderGroup",
  "altGroup",
  "initRef",
  "depends",
  "template",
  "temporalId",
  "spatialId",
  "codec",
  "mimeType",
  "framerate",
  "timescale",
  "bitrate",
  "avgBitrate",
  "maxGopDuration",
  "maxGroupDuration",
  "width",
  "height",
  "samplerate",
  "channelConfig",
  "displayWidth",
  "displayHeight",
  "lang",
  "parentName",
  "parentNamespace",
  "trackDuration",
  "encryptionScheme",
  "cipherSuite",
  "keyId",
  "trackBaseKey",
  "authInfo",
  "accessibility",
  "connectionUri",
  "token",
]);

/**
 * 既知フィールドを pick して `CatalogTrack` を組み立てる共通ロジック。
 *
 * `name`, `packaging`, `isLive` は呼び出し側で検証済み。残りの optional
 * フィールドの型・MUST/MUST NOT 制約をここで検証する。
 *
 * `options.skipPackagingRequiredFields` は clone operation 用。clone では
 * packaging が継承される (= undefined のことがある) ため、packaging に応じた
 * MUST 検証 (depends / eventType / mimeType="application/json") を skip する。
 */
export function buildValidatedCatalogTrack(
  obj: Record<string, unknown>,
  name: string,
  packaging: PackagingType | undefined,
  isLive: boolean | undefined,
  options?: { skipPackagingRequiredFields?: boolean },
): CatalogTrack {
  const track: CatalogTrack = { name } as CatalogTrack;
  if (packaging !== undefined) track.packaging = packaging;
  if (isLive !== undefined) track.isLive = isLive;

  pickIdentityFields(obj, name, track);
  pickEventType(obj, name, packaging, track);
  pickLatencyAndBuffers(obj, name, track);
  pickGroupAndInitRef(obj, name, track);
  pickDependsAndTemplate(obj, name, track);
  pickNumericAndStringFields(obj, name, track);
  pickTrackDuration(obj, name, isLive, track);
  pickEncryptionFields(obj, name, track);
  pickAuthAndAccessibility(obj, name, track);
  pickPublishTrackFields(obj, name, track);

  if (!options?.skipPackagingRequiredFields && packaging !== undefined) {
    validatePackagingSpecificRules(track, packaging, name);
  }

  // §5 parser MUST ignore unknown fields → 検証はしないが保持する（§5.4 Variable Substitution 対象）
  const trackRecord = track as unknown as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TRACK_FIELDS.has(key)) {
      trackRecord[key] = obj[key];
    }
  }

  return track;
}

/** namespace / role / label (§5.2.2 / §5.2.6 / §5.2.10) を pick する */
function pickIdentityFields(obj: Record<string, unknown>, name: string, track: CatalogTrack): void {
  if ("namespace" in obj) {
    const value = obj["namespace"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': namespace must be a string per §5.2.2, got ${typeof value}`,
      );
    }
    track.namespace = value;
  }
  if ("role" in obj) {
    const value = obj["role"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': role must be a string per §5.2.6, got ${typeof value}`,
      );
    }
    track.role = value;
  }
  if ("label" in obj) {
    const value = obj["label"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': label must be a string per §5.2.10, got ${typeof value}`,
      );
    }
    track.label = value;
  }
}

/** eventType を pick する (§5.2.5) */
function pickEventType(
  obj: Record<string, unknown>,
  name: string,
  packaging: PackagingType | undefined,
  track: CatalogTrack,
): void {
  if (!("eventType" in obj)) return;
  const value = obj["eventType"];
  if (typeof value !== "string") {
    throw new Error(
      `invalid track '${name}': eventType must be a string per §5.2.5, got ${typeof value}`,
    );
  }
  if (packaging !== undefined && packaging !== "eventtimeline") {
    throw new Error(
      `invalid track '${name}': eventType must not be used unless packaging is 'eventtimeline' per §5.2.5, got packaging='${packaging}'`,
    );
  }
  track.eventType = value;
}

/** targetLatency / buffers の相互排他検証と pick (§5.2.8 / §5.2.9) */
function pickLatencyAndBuffers(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  const hasTargetLatency = "targetLatency" in obj;
  const hasBuffers = "buffers" in obj;
  if (hasTargetLatency && hasBuffers) {
    throw new Error(
      `invalid track '${name}': targetLatency and buffers must not coexist per §5.2.8 / §5.2.9`,
    );
  }
  if (hasTargetLatency) {
    const value = obj["targetLatency"];
    if (typeof value !== "number") {
      throw new Error(
        `invalid track '${name}': targetLatency must be a number per §5.2.8, got ${typeof value}`,
      );
    }
    track.targetLatency = value;
  }
  if (hasBuffers) {
    track.buffers = validateBuffers(obj["buffers"], name);
  }
}

/** renderGroup / altGroup / initRef を pick する (§5.2.11 / §5.2.12 / §5.2.13) */
function pickGroupAndInitRef(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalNumber(obj, "renderGroup", "§5.2.11", track, name);
  pickOptionalNumber(obj, "altGroup", "§5.2.12", track, name);
  pickOptionalString(obj, "initRef", "§5.2.13", track, name);
}

/** depends / template を pick する (§5.2.14 / §5.2.15) */
function pickDependsAndTemplate(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("depends" in obj) {
    const value = obj["depends"];
    if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
      throw new Error(`invalid track '${name}': depends must be an array of strings per §5.2.14`);
    }
    track.depends = value;
  }
  if ("template" in obj) {
    track.template = validateMediaTimelineTemplate(obj["template"], name);
  }
}

/** temporalId/spatialId/codec/mimeType/dimension 系の単純な pick (§5.2.16〜§5.2.32) */
function pickNumericAndStringFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalNumber(obj, "temporalId", "§5.2.16", track, name);
  pickOptionalNumber(obj, "spatialId", "§5.2.17", track, name);
  pickOptionalString(obj, "codec", "§5.2.18", track, name);
  pickOptionalString(obj, "mimeType", "§5.2.19", track, name);
  pickOptionalNumber(obj, "framerate", "§5.2.20", track, name);
  pickOptionalNumber(obj, "timescale", "§5.2.21", track, name);
  pickOptionalNumber(obj, "bitrate", "§5.2.22", track, name);
  pickOptionalNumber(obj, "avgBitrate", "§5.2.23", track, name);
  pickOptionalNumber(obj, "maxGopDuration", "§5.2.24", track, name);
  pickOptionalNumber(obj, "maxGroupDuration", "§5.2.25", track, name);
  pickOptionalNumber(obj, "width", "§5.2.26", track, name);
  pickOptionalNumber(obj, "height", "§5.2.27", track, name);
  pickOptionalNumber(obj, "samplerate", "§5.2.28", track, name);
  pickOptionalString(obj, "channelConfig", "§5.2.29", track, name);
  pickOptionalNumber(obj, "displayWidth", "§5.2.30", track, name);
  pickOptionalNumber(obj, "displayHeight", "§5.2.31", track, name);
  pickOptionalString(obj, "lang", "§5.2.32", track, name);
}

/** trackDuration を pick する (§5.2.35、isLive=true 時 MUST NOT) */
function pickTrackDuration(
  obj: Record<string, unknown>,
  name: string,
  isLive: boolean | undefined,
  track: CatalogTrack,
): void {
  if (!("trackDuration" in obj)) return;
  const value = obj["trackDuration"];
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${name}': trackDuration must be a number per §5.2.35, got ${typeof value}`,
    );
  }
  if (isLive === true) {
    throw new Error(
      `invalid track '${name}': trackDuration must not be included when isLive is true per §5.2.35`,
    );
  }
  track.trackDuration = value;
}

/** 暗号化系フィールドを pick する (§5.2.38〜§5.2.41) */
function pickEncryptionFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  pickOptionalString(obj, "encryptionScheme", "§5.2.38", track, name);
  pickOptionalString(obj, "cipherSuite", "§5.2.39", track, name);
  pickOptionalString(obj, "keyId", "§5.2.40", track, name);
  pickOptionalString(obj, "trackBaseKey", "§5.2.41", track, name);
  // §5.2.39: cipherSuite MUST be present when encryptionScheme is specified.
  if (track.encryptionScheme !== undefined && track.cipherSuite === undefined) {
    throw new Error(
      `invalid track '${name}': cipherSuite must be present when encryptionScheme is specified per §5.2.39`,
    );
  }
}

/** authInfo / accessibility を pick する (§5.2.42 / §5.2.44) */
function pickAuthAndAccessibility(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("authInfo" in obj) {
    const value = obj["authInfo"];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `invalid track '${name}': authInfo must be an object per §5.2.42, got ${
          value === null ? "null" : Array.isArray(value) ? "array" : typeof value
        }`,
      );
    }
    track.authInfo = value as AuthInfo;
  }
  if ("accessibility" in obj) {
    track.accessibility = validateAccessibility(obj["accessibility"], name);
  }
}

/** publishTracks 専用 (connectionUri / token) を pick する (§5.2.36 / §5.2.37) */
function pickPublishTrackFields(
  obj: Record<string, unknown>,
  name: string,
  track: CatalogTrack,
): void {
  if ("connectionUri" in obj) {
    const value = obj["connectionUri"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': connectionUri must be a string per §5.2.36, got ${typeof value}`,
      );
    }
    (track as PublishTrack).connectionUri = value;
  }
  if ("token" in obj) {
    const value = obj["token"];
    if (typeof value !== "string") {
      throw new Error(
        `invalid track '${name}': token must be a string per §5.2.37, got ${typeof value}`,
      );
    }
    (track as PublishTrack).token = value;
  }
}

/**
 * packaging に応じた MUST 検証
 * (§5.2.5 / §7.2 / §8.2)
 */
export function validatePackagingSpecificRules(
  track: CatalogTrack,
  packaging: PackagingType,
  name: string,
): void {
  if (packaging === "mediatimeline") {
    // §7.2: depends MUST present, mimeType MUST = "application/json"
    if (track.depends === undefined) {
      throw new Error(`invalid track '${name}': mediatimeline track must include depends per §7.2`);
    }
    if (track.mimeType !== "application/json") {
      throw new Error(
        `invalid track '${name}': mediatimeline track must have mimeType='application/json' per §7.2, got '${
          track.mimeType ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "eventtimeline") {
    // §5.2.5 / §8.2: eventType MUST, depends MUST, mimeType MUST = "application/json"
    if (track.eventType === undefined) {
      throw new Error(
        `invalid track '${name}': eventtimeline track must include eventType per §5.2.5 / §8.2`,
      );
    }
    if (track.depends === undefined) {
      throw new Error(`invalid track '${name}': eventtimeline track must include depends per §8.2`);
    }
    if (track.mimeType !== "application/json") {
      throw new Error(
        `invalid track '${name}': eventtimeline track must have mimeType='application/json' per §8.2, got '${
          track.mimeType ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "moqlog") {
    // §9.4: packaging="moqlog" の Log track は role="log" が MUST
    if (track.role !== "log") {
      throw new Error(
        `invalid track '${name}': moqlog track must have role='log' per §9.4, got '${
          track.role ?? "(absent)"
        }'`,
      );
    }
  } else if (packaging === "moqmetrics") {
    // §10.4: packaging="moqmetrics" の Metrics track は role="metrics" が MUST
    if (track.role !== "metrics") {
      throw new Error(
        `invalid track '${name}': moqmetrics track must have role='metrics' per §10.4, got '${
          track.role ?? "(absent)"
        }'`,
      );
    }
  }

  // packaging に対する MUST NOT 検証。
  // §5.2.5: eventType MUST NOT be used unless packaging is 'eventtimeline'.
  // validateCatalogTrack 側でも検証しているが、clone 後の合成 track (base から eventType を継承し
  // packaging のみ override したケース) は validateCloneCatalogTrack で MUST 系をすべて skip して
  // いるため、applyCatalogDelta 後段からも本関数が呼ばれる経路で検出する必要がある。
  if (packaging !== "eventtimeline" && track.eventType !== undefined) {
    throw new Error(
      `invalid track '${name}': eventType must not be used unless packaging is 'eventtimeline' per §5.2.5, got packaging='${packaging}'`,
    );
  }
}

function pickOptionalNumber(
  obj: Record<string, unknown>,
  key: string,
  section: string,
  track: CatalogTrack,
  trackName: string,
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${trackName}': ${key} must be a number per ${section}, got ${typeof value}`,
    );
  }
  (track as unknown as Record<string, unknown>)[key] = value;
}

function pickOptionalString(
  obj: Record<string, unknown>,
  key: string,
  section: string,
  track: CatalogTrack,
  trackName: string,
): void {
  if (!(key in obj)) return;
  const value = obj[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid track '${trackName}': ${key} must be a string per ${section}, got ${typeof value}`,
    );
  }
  (track as unknown as Record<string, unknown>)[key] = value;
}

function validateBuffers(value: unknown, trackName: string): Buffers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `invalid track '${trackName}': buffers must be an object per §5.2.9, got ${
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      }`,
    );
  }
  const obj = value as Record<string, unknown>;
  const buffers: Buffers = {};
  for (const key of ["target", "min", "max"] as const) {
    if (key in obj) {
      const v = obj[key];
      if (typeof v !== "number") {
        throw new Error(
          `invalid track '${trackName}': buffers.${key} must be a number per §5.2.9, got ${typeof v}`,
        );
      }
      buffers[key] = v;
    }
  }
  // §5.2.9: Unknown keys in the target buffer object MUST be ignored → 未知キーは無視
  return buffers;
}

function validateAccessibility(value: unknown, trackName: string): AccessibilityDescriptor[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `invalid track '${trackName}': accessibility must be an array per §5.2.44, got ${typeof value}`,
    );
  }
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}] must be an object per §5.2.44, got ${
          entry === null ? "null" : typeof entry
        }`,
      );
    }
    const obj = entry as Record<string, unknown>;
    const scheme = obj["scheme"];
    const v = obj["value"];
    if (typeof scheme !== "string") {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}].scheme must be a string per §5.2.44, got ${typeof scheme}`,
      );
    }
    if (typeof v !== "string") {
      throw new Error(
        `invalid track '${trackName}': accessibility[${i}].value must be a string per §5.2.44, got ${typeof v}`,
      );
    }
    return { scheme, value: v };
  });
}

/**
 * MediaTimelineTemplate を検証する (draft-ietf-moq-msf-01 §5.2.15 / §7.4.1)
 *
 * §7.4.1: 6 要素 JSON Array、各要素の型と順序は固定。
 * Location 要素は 2 要素 number 配列、bigint 変換時に precision loss を検出する。
 */
function validateMediaTimelineTemplate(value: unknown, trackName: string): MediaTimelineTemplate {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new Error(
      `invalid track '${trackName}': template must be a 6-element array per §7.4.1, got ${
        Array.isArray(value) ? `array of length ${value.length}` : typeof value
      }`,
    );
  }

  const startMediaTime = assertTemplateNumber(value[0], trackName, "startMediaTime");
  const deltaMediaTime = assertTemplateNumber(value[1], trackName, "deltaMediaTime");
  const startLocation = assertTemplateLocation(value[2], trackName, "startLocation");
  const deltaLocation = assertTemplateLocation(value[3], trackName, "deltaLocation");
  const startWallclock = assertTemplateNumber(value[4], trackName, "startWallclock");
  const deltaWallclock = assertTemplateNumber(value[5], trackName, "deltaWallclock");

  return [
    startMediaTime,
    deltaMediaTime,
    startLocation,
    deltaLocation,
    startWallclock,
    deltaWallclock,
  ] as const;
}

function assertTemplateNumber(value: unknown, trackName: string, field: string): number {
  if (typeof value !== "number") {
    throw new Error(
      `invalid track '${trackName}': template ${field} must be a number per §7.4.1, got ${typeof value}`,
    );
  }
  return value;
}

function assertTemplateLocation(
  value: unknown,
  trackName: string,
  field: string,
): readonly [bigint, bigint] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(
      `invalid track '${trackName}': template ${field} must be a 2-element array per §7.4.1, got ${
        Array.isArray(value) ? `array of length ${value.length}` : typeof value
      }`,
    );
  }
  const groupId = toTemplateLocationBigInt(value[0], trackName, `${field}[0]`);
  const objectId = toTemplateLocationBigInt(value[1], trackName, `${field}[1]`);
  return [groupId, objectId] as const;
}

function toTemplateLocationBigInt(value: unknown, trackName: string, field: string): bigint {
  return toMsfLocationBigInt(value, `template ${field}`, `track '${trackName}'`);
}
