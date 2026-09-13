/**
 * MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
 *
 * wallclock-range / mediatime-range / location-range / c4m の取得をまとめる。
 *
 * 参照: draft-ietf-moq-msf-01
 */

// =============================================================================
// MSF URI Fragment reserved key helpers (draft-ietf-moq-msf-01 §11.1.1)
// =============================================================================

/**
 * wallclock-range / mediatime-range のパース結果
 */
export interface MsfTimeRange {
  start: number;
  end?: number;
}

/**
 * location-range のパース結果
 */
export interface MsfLocationRange {
  start: { groupId: bigint; objectId?: bigint };
  end?: { groupId: bigint; objectId?: bigint };
}

/**
 * wallclock-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: range は inclusive。終端省略で open range MAY。
 * 同一 key 複数は union MUST。不正値はスキップして走査を続行する。
 * start 省略形（例: "-200"）は不正値としてスキップする。
 */
export function getWallclockRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfTimeRange[] {
  return parseTimeRanges(parameters, "wallclock-range");
}

/**
 * mediatime-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: wallclock-range と同じ形式。
 */
export function getMediatimeRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfTimeRange[] {
  return parseTimeRanges(parameters, "mediatime-range");
}

/**
 * location-range パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: Group.Object を `.`、範囲を `-` で区切る。
 * 第 2 値省略時は `.` / `-` を MUST omit。
 * 不正値はスキップして走査を続行する。
 */
export function getLocationRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
): MsfLocationRange[] {
  const ranges: MsfLocationRange[] = [];
  for (const [key, value] of parameters) {
    if (key !== "location-range") continue;
    const parsed = parseLocationRangeValue(value);
    if (parsed !== undefined) {
      ranges.push(parsed);
    }
  }
  return ranges;
}

/**
 * c4m パラメータを取得する
 *
 * draft-ietf-moq-msf-01 §11.1.1: base64 文字列のまま返す。検証しない。
 * 最初の c4m エントリを返す。
 */
export function getC4mParameter(
  parameters: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  for (const [key, value] of parameters) {
    if (key === "c4m") {
      return value;
    }
  }
  return undefined;
}

/**
 * wallclock-range / mediatime-range の共通パース処理
 */
function parseTimeRanges(
  parameters: ReadonlyArray<readonly [string, string]>,
  keyName: string,
): MsfTimeRange[] {
  const ranges: MsfTimeRange[] = [];
  for (const [key, value] of parameters) {
    if (key !== keyName) continue;
    const parsed = parseTimeRangeValue(value);
    if (parsed !== undefined) {
      ranges.push(parsed);
    }
  }
  return ranges;
}

/**
 * "start-end" 形式の time range 値をパースする。
 * 不正値は undefined を返す（スキップ）。
 */
function parseTimeRangeValue(value: string): MsfTimeRange | undefined {
  if (value.length === 0) return undefined;
  // start 省略形（"-200"）は不正
  if (value.startsWith("-")) return undefined;

  const dashIndex = value.indexOf("-");
  if (dashIndex === -1) {
    // start のみ
    const start = Number(value);
    if (!Number.isFinite(start)) return undefined;
    return { start };
  }

  const startStr = value.slice(0, dashIndex);
  const endStr = value.slice(dashIndex + 1);
  if (startStr.length === 0) return undefined;

  const start = Number(startStr);
  if (!Number.isFinite(start)) return undefined;

  if (endStr.length === 0) {
    // open range: "start-"
    return { start };
  }

  const end = Number(endStr);
  if (!Number.isFinite(end)) return undefined;

  return { start, end };
}

/**
 * location-range 値をパースする。
 * 形式: "Group.Object-Group.Object" / "Group.Object" / "Group-Group"
 * 不正値は undefined を返す（スキップ）。
 */
function parseLocationRangeValue(value: string): MsfLocationRange | undefined {
  if (value.length === 0) return undefined;
  // start 省略形（"-..."）は不正
  if (value.startsWith("-")) return undefined;

  const dashIndex = value.indexOf("-");
  if (dashIndex === -1) {
    // start のみ
    const start = parseLocationPoint(value);
    if (start === undefined) return undefined;
    return { start };
  }

  const startStr = value.slice(0, dashIndex);
  const endStr = value.slice(dashIndex + 1);
  if (startStr.length === 0) return undefined;

  const start = parseLocationPoint(startStr);
  if (start === undefined) return undefined;

  if (endStr.length === 0) {
    // open range: "start-"
    return { start };
  }

  const end = parseLocationPoint(endStr);
  if (end === undefined) return undefined;

  return { start, end };
}

/**
 * "Group" または "Group.Object" 形式をパースする。
 * ドット過多（"1.2.3"）や末尾ドット（"1."）は不正。
 */
function parseLocationPoint(value: string): { groupId: bigint; objectId?: bigint } | undefined {
  if (value.length === 0) return undefined;

  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) {
    // Group のみ
    const groupId = parseNonNegativeBigInt(value);
    if (groupId === undefined) return undefined;
    return { groupId };
  }

  // ドットが複数ある場合は不正
  if (value.includes(".", dotIndex + 1)) return undefined;

  const groupStr = value.slice(0, dotIndex);
  const objectStr = value.slice(dotIndex + 1);
  // 末尾ドット（"1."）は不正
  if (groupStr.length === 0 || objectStr.length === 0) return undefined;

  const groupId = parseNonNegativeBigInt(groupStr);
  if (groupId === undefined) return undefined;

  const objectId = parseNonNegativeBigInt(objectStr);
  if (objectId === undefined) return undefined;

  return { groupId, objectId };
}

/**
 * 非負整数文字列を bigint にパースする。不正値は undefined。
 */
function parseNonNegativeBigInt(value: string): bigint | undefined {
  if (value.length === 0) return undefined;
  if (!/^[0-9]+$/.test(value)) return undefined;
  return BigInt(value);
}
