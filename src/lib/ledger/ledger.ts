/**
 * 调度账核心：派单校验、离线位置合并、失效级联、乐观并发占用。
 * 全部为纯函数：输入当前 LedgerState 与命令，返回新状态与结果，不落任何副作用。
 */
import type {
  AssetStatus,
  DispatchCommand,
  LedgerEntry,
  LedgerState,
  Mission,
  OccupyCommand,
  OccupancyConflict,
  PositionReport,
  Rejection,
  RescueAsset,
  SearchArea,
  TimeWindow,
} from './types';

const ACTIVE_MISSION: Mission['status'][] = ['dispatched', 'in_progress'];

const now = (at?: string) => at ?? new Date().toISOString();
const ms = (iso: string) => new Date(iso).getTime();

/** 复制一份可变的账本草稿，所有修改在草稿上进行 */
function draft(state: LedgerState): LedgerState {
  return {
    areas: state.areas.map((a) => ({ ...a })),
    assets: state.assets.map((a) => ({ ...a, availableWindows: a.availableWindows.map((w) => ({ ...w })) })),
    missions: state.missions.map((m) => ({ ...m, assetIds: [...m.assetIds], window: { ...m.window } })),
    positions: state.positions.map((p) => ({ ...p })),
    reportIds: [...state.reportIds],
    reviewQueue: state.reviewQueue.map((r) => ({ ...r, report: { ...r.report } })),
    entries: [...state.entries],
    seq: state.seq,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EntryDraft = DistributiveOmit<LedgerEntry, 'seq'>;

/** 入账：追加一条带序号的账本条目 */
function book(d: LedgerState, entry: EntryDraft): void {
  d.entries.push({ ...entry, seq: d.seq } as LedgerEntry);
  d.seq += 1;
}

const findArea = (d: LedgerState, id: string) => d.areas.find((a) => a.id === id);
const findAsset = (d: LedgerState, id: string) => d.assets.find((a) => a.id === id);
const findMission = (d: LedgerState, id: string) => d.missions.find((m) => m.id === id);

const windowCovers = (windows: TimeWindow[], w: TimeWindow) =>
  windows.some((win) => ms(win.start) <= ms(w.start) && ms(win.end) >= ms(w.end));

const isOccupied = (d: LedgerState, assetId: string, exceptMissionId?: string) =>
  d.missions.some(
    (m) => m.id !== exceptMissionId && ACTIVE_MISSION.includes(m.status) && m.assetIds.includes(assetId),
  );

/** 单位是否可派：返回全部不满足的原因（空数组即可派） */
export function assessAsset(
  state: LedgerState,
  assetId: string,
  window: TimeWindow,
  requiredEnduranceMinutes: number,
  exceptMissionId?: string,
): Rejection[] {
  const asset = findAsset(state, assetId);
  if (!asset) return [{ code: 'asset_unknown', assetId, message: `单位 ${assetId} 不存在` }];
  const reasons: Rejection[] = [];
  if (asset.status !== 'ready') {
    const label: Record<AssetStatus, string> = {
      ready: '',
      assigned: '已在任务中',
      offline: '离线失联',
      returning: '续航耗尽返航中',
    };
    reasons.push({ code: 'asset_unavailable', assetId, message: `${asset.name} 当前不可派（${label[asset.status]}）` });
  }
  if (isOccupied(state, assetId, exceptMissionId)) {
    reasons.push({ code: 'asset_occupied', assetId, message: `${asset.name} 已挂在其他进行中任务上` });
  }
  if (!windowCovers(asset.availableWindows, window)) {
    reasons.push({ code: 'window_mismatch', assetId, message: `${asset.name} 的可用时段覆盖不了任务窗口` });
  }
  if (asset.enduranceMinutes < requiredEnduranceMinutes) {
    reasons.push({
      code: 'endurance_insufficient',
      assetId,
      message: `${asset.name} 剩余续航 ${asset.enduranceMinutes} 分钟，不足任务所需 ${requiredEnduranceMinutes} 分钟`,
    });
  }
  return reasons;
}

/** 派单前校验：区域状态、单位可用性、时段、续航、版本快照 */
export function validateDispatch(state: LedgerState, cmd: DispatchCommand): Rejection[] {
  const reasons: Rejection[] = [];
  const area = findArea(state, cmd.areaId);
  if (!area) {
    reasons.push({ code: 'area_unknown', message: `搜索区 ${cmd.areaId} 不存在` });
  } else if (area.status !== 'active') {
    reasons.push({
      code: 'area_not_active',
      message: `搜索区「${area.name}」当前为${area.status === 'closed' ? '已关闭' : '规划中'}，不能接单`,
    });
  }
  for (const assetId of cmd.assetIds) {
    reasons.push(...assessAsset(state, assetId, cmd.window, cmd.requiredEnduranceMinutes));
    const expected = cmd.expectedVersions?.[assetId];
    const asset = findAsset(state, assetId);
    if (asset && expected !== undefined && expected !== asset.version) {
      reasons.push({
        code: 'version_conflict',
        assetId,
        message: `${asset.name} 的版本已变化（开具时为 v${expected}，当前 v${asset.version}），请重新选择`,
      });
    }
  }
  return reasons;
}

export type DispatchResult =
  | { ok: true; state: LedgerState; missionId: string }
  | { ok: false; state: LedgerState; reasons: Rejection[] };

/** 派单：校验通过则任务与占用一并入账；否则整单拒绝并留痕 */
export function dispatch(state: LedgerState, cmd: DispatchCommand): DispatchResult {
  const d = draft(state);
  const at = now(cmd.at);
  const reasons = validateDispatch(d, cmd);
  if (reasons.length > 0) {
    book(d, { at, actor: cmd.actor, kind: 'dispatch_rejected', title: cmd.title, reasons });
    return { ok: false, state: d, reasons };
  }
  const mission: Mission = {
    id: `mission-${d.seq}`,
    title: cmd.title,
    areaId: cmd.areaId,
    assetIds: [...cmd.assetIds],
    status: 'dispatched',
    priority: cmd.priority,
    note: cmd.note,
    window: { ...cmd.window },
    requiredEnduranceMinutes: cmd.requiredEnduranceMinutes,
    sweptCoverage: 0,
    updatedAt: at,
    version: 1,
  };
  d.missions.unshift(mission);
  book(d, { at, actor: cmd.actor, kind: 'mission_dispatched', missionId: mission.id, areaId: cmd.areaId, assetIds: mission.assetIds });
  for (const assetId of cmd.assetIds) {
    occupyInDraft(d, assetId, mission.id, cmd.actor, at);
  }
  return { ok: true, state: d, missionId: mission.id };
}

/** 草稿内占用：状态、版本、入账一步到位 */
function occupyInDraft(d: LedgerState, assetId: string, missionId: string, actor: string, at: string): void {
  const asset = findAsset(d, assetId);
  if (!asset) return;
  asset.status = 'assigned';
  asset.version += 1;
  book(d, { at, actor, kind: 'asset_occupied', assetId, missionId, version: asset.version });
}

export type OccupyResult =
  | { ok: true; state: LedgerState; version: number }
  | { ok: false; state: LedgerState; conflict?: OccupancyConflict; reasons?: Rejection[] };

/**
 * 占用单位（加入已有任务）。两名值班员同时提交同一单位时：
 * 先写入者把版本 +1 生效；后到者版本不符，看到冲突并重新选择。
 */
export function occupyAsset(state: LedgerState, cmd: OccupyCommand): OccupyResult {
  const d = draft(state);
  const at = now(cmd.at);
  const asset = findAsset(d, cmd.assetId);
  const mission = findMission(d, cmd.missionId);
  if (!asset || !mission) {
    return { ok: false, state: d, reasons: [{ code: 'asset_unknown', message: '单位或任务不存在' }] };
  }
  if (asset.version !== cmd.expectedVersion) {
    book(d, {
      at,
      actor: cmd.actor,
      kind: 'occupancy_conflict',
      assetId: cmd.assetId,
      missionId: cmd.missionId,
      expectedVersion: cmd.expectedVersion,
      actualVersion: asset.version,
    });
    return { ok: false, state: d, conflict: { expectedVersion: cmd.expectedVersion, actualVersion: asset.version } };
  }
  const reasons = assessAsset(d, cmd.assetId, mission.window, mission.requiredEnduranceMinutes, mission.id);
  if (reasons.length > 0) {
    book(d, { at, actor: cmd.actor, kind: 'dispatch_rejected', title: `占用 ${asset.name}`, reasons });
    return { ok: false, state: d, reasons };
  }
  occupyInDraft(d, cmd.assetId, cmd.missionId, cmd.actor, at);
  mission.assetIds.push(cmd.assetId);
  mission.updatedAt = at;
  return { ok: true, state: d, version: findAsset(d, cmd.assetId)!.version };
}

/** 释放单位并入账（任务完成/失效时调用） */
function releaseInDraft(d: LedgerState, assetId: string, missionId: string, actor: string, at: string): void {
  const asset = findAsset(d, assetId);
  if (!asset) return;
  if (asset.status === 'assigned') asset.status = 'ready';
  asset.version += 1;
  book(d, { at, actor, kind: 'asset_released', assetId, missionId });
}

/** 重算区域覆盖率：未失效任务的扫测贡献之和，封顶 100 */
function recomputeCoverage(d: LedgerState, areaId: string, actor: string, at: string): void {
  const area = findArea(d, areaId);
  if (!area) return;
  const coverage = Math.min(
    100,
    d.missions
      .filter((m) => m.areaId === areaId && m.status !== 'invalidated' && m.status !== 'draft')
      .reduce((sum, m) => sum + m.sweptCoverage, 0),
  );
  if (coverage !== area.coverage) {
    area.coverage = coverage;
    area.version += 1;
    book(d, { at, actor, kind: 'coverage_recomputed', areaId, coverage });
  }
}

/** 失效退回：任务作废、释放单位、重算覆盖率；已完成任务留档不受影响 */
function invalidateMission(d: LedgerState, mission: Mission, reason: Mission['invalidReason'] & string, actor: string, at: string): void {
  mission.status = 'invalidated';
  mission.invalidReason = reason;
  mission.updatedAt = at;
  mission.version += 1;
  book(d, { at, actor, kind: 'mission_invalidated', missionId: mission.id, reason: reason as 'area_unavailable' | 'endurance_exhausted' });
  for (const assetId of mission.assetIds) releaseInDraft(d, assetId, mission.id, actor, at);
  recomputeCoverage(d, mission.areaId, actor, at);
}

/** 区域状态变化：变为非 active 时，区域内活跃任务失效退回并重算覆盖率 */
export function setAreaStatus(
  state: LedgerState,
  cmd: { areaId: string; status: SearchArea['status']; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const area = findArea(d, cmd.areaId);
  if (!area || area.status === cmd.status) return d;
  const from = area.status;
  area.status = cmd.status;
  area.version += 1;
  book(d, { at, actor: cmd.actor, kind: 'area_status_changed', areaId: cmd.areaId, from, to: cmd.status });
  if (cmd.status !== 'active') {
    for (const mission of d.missions.filter((m) => m.areaId === cmd.areaId && ACTIVE_MISSION.includes(m.status))) {
      invalidateMission(d, mission, 'area_unavailable', cmd.actor, at);
    }
  }
  return d;
}

/** 任务推进：dispatched → in_progress */
export function startMission(state: LedgerState, cmd: { missionId: string; actor: string; at?: string }): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const mission = findMission(d, cmd.missionId);
  if (!mission || mission.status !== 'dispatched') return d;
  mission.status = 'in_progress';
  mission.updatedAt = at;
  mission.version += 1;
  book(d, { at, actor: cmd.actor, kind: 'mission_started', missionId: mission.id });
  return d;
}

/** 任务完成：落账扫测贡献、释放单位、重算覆盖率，任务留档 */
export function completeMission(
  state: LedgerState,
  cmd: { missionId: string; sweptCoverage?: number; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const mission = findMission(d, cmd.missionId);
  if (!mission || !ACTIVE_MISSION.includes(mission.status)) return d;
  if (cmd.sweptCoverage !== undefined) mission.sweptCoverage = cmd.sweptCoverage;
  mission.status = 'completed';
  mission.updatedAt = at;
  mission.version += 1;
  book(d, { at, actor: cmd.actor, kind: 'mission_completed', missionId: mission.id, sweptCoverage: mission.sweptCoverage });
  for (const assetId of mission.assetIds) releaseInDraft(d, assetId, mission.id, cmd.actor, at);
  recomputeCoverage(d, mission.areaId, cmd.actor, at);
  return d;
}

/** 手动标记单位状态（失联/恢复在线等），入账并升版本 */
export function setAssetStatus(
  state: LedgerState,
  cmd: { assetId: string; status: AssetStatus; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const asset = findAsset(d, cmd.assetId);
  if (!asset || asset.status === cmd.status) return d;
  const from = asset.status;
  asset.status = cmd.status;
  asset.version += 1;
  book(d, { at, actor: cmd.actor, kind: 'asset_status_changed', assetId: asset.id, from, to: cmd.status });
  return d;
}

/** 续航消耗：归零即返航，相关活跃任务失效退回并重算覆盖率 */
export function consumeEndurance(
  state: LedgerState,
  cmd: { assetId: string; minutes: number; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const asset = findAsset(d, cmd.assetId);
  if (!asset || cmd.minutes <= 0) return d;
  asset.enduranceMinutes = Math.max(0, asset.enduranceMinutes - cmd.minutes);
  book(d, { at, actor: cmd.actor, kind: 'endurance_consumed', assetId: asset.id, remainingMinutes: asset.enduranceMinutes });
  if (asset.enduranceMinutes === 0 && asset.status !== 'returning') {
    const from = asset.status;
    asset.status = 'returning';
    asset.version += 1;
    book(d, { at, actor: cmd.actor, kind: 'asset_status_changed', assetId: asset.id, from, to: 'returning' });
    for (const mission of d.missions.filter((m) => ACTIVE_MISSION.includes(m.status) && m.assetIds.includes(asset.id))) {
      invalidateMission(d, mission, 'endurance_exhausted', cmd.actor, at);
    }
  }
  return d;
}

/**
 * 离线位置合并：回网后按编号与观测时刻入账。
 * - 编号重复：忽略（幂等）；
 * - 同一单位同一观测时刻：保留接收较新者，另一条留待核对；
 * - 单位位置取观测时刻最新的一条；离线单位有新鲜位置即恢复在线。
 */
export function mergeReports(
  state: LedgerState,
  cmd: { reports: PositionReport[]; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  // 批内顺序不影响结果：按接收时刻（再按编号）升序处理，后到者自然胜出
  const incoming = [...cmd.reports].sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt) || a.id.localeCompare(b.id));
  for (const report of incoming) {
    if (d.reportIds.includes(report.id)) {
      book(d, { at, actor: cmd.actor, kind: 'position_duplicate_ignored', reportId: report.id, assetId: report.assetId });
      continue;
    }
    const rival = d.positions.find((p) => p.assetId === report.assetId && p.observedAt === report.observedAt);
    d.reportIds.push(report.id);
    if (rival && ms(rival.receivedAt) >= ms(report.receivedAt)) {
      // 已入账的同刻报告接收更新或同时，本条留待核对
      d.reviewQueue.push({ report: { ...report }, keptReportId: rival.id, reason: 'same_observed_at_older_receipt' });
      book(d, { at, actor: cmd.actor, kind: 'position_queued_for_review', reportId: report.id, keptReportId: rival.id, assetId: report.assetId });
      continue;
    }
    if (rival) {
      // 本条接收更新，挤掉已入账的同刻报告，被挤掉的留待核对
      d.positions = d.positions.filter((p) => p !== rival);
      d.reviewQueue.push({ report: { ...rival }, keptReportId: report.id, reason: 'same_observed_at_older_receipt' });
      book(d, { at, actor: cmd.actor, kind: 'position_queued_for_review', reportId: rival.id, keptReportId: report.id, assetId: rival.assetId });
    }
    d.positions.push({ ...report });
    book(d, { at, actor: cmd.actor, kind: 'position_applied', reportId: report.id, assetId: report.assetId, observedAt: report.observedAt });
  }
  // 每个单位的位置以观测时刻最新的入账报告为准
  for (const asset of d.assets) {
    const own = d.positions.filter((p) => p.assetId === asset.id);
    if (own.length === 0) continue;
    const latest = own.reduce((a, b) => (ms(a.observedAt) >= ms(b.observedAt) ? a : b));
    if (asset.lat !== latest.lat || asset.lng !== latest.lng || asset.lastSeen !== latest.observedAt) {
      asset.lat = latest.lat;
      asset.lng = latest.lng;
      asset.lastSeen = latest.observedAt;
    }
    if (asset.status === 'offline') {
      asset.status = 'ready';
      asset.version += 1;
      book(d, { at, actor: cmd.actor, kind: 'asset_status_changed', assetId: asset.id, from: 'offline', to: 'ready' });
    }
  }
  return d;
}

/** 核对队列处理：采纳（以该报告为准更新位置）或作废 */
export function resolveReview(
  state: LedgerState,
  cmd: { reportId: string; outcome: 'adopted' | 'dismissed'; actor: string; at?: string },
): LedgerState {
  const d = draft(state);
  const at = now(cmd.at);
  const item = d.reviewQueue.find((r) => r.report.id === cmd.reportId);
  if (!item) return d;
  d.reviewQueue = d.reviewQueue.filter((r) => r.report.id !== cmd.reportId);
  if (cmd.outcome === 'adopted') {
    const asset = findAsset(d, item.report.assetId);
    if (asset) {
      asset.lat = item.report.lat;
      asset.lng = item.report.lng;
      asset.lastSeen = item.report.observedAt;
      asset.version += 1;
    }
  }
  book(d, { at, actor: cmd.actor, kind: 'review_resolved', reportId: cmd.reportId, outcome: cmd.outcome });
  return d;
}

/** 初始账：由种子数据折叠出第一份状态 */
export function openLedger(seed: {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
}): LedgerState {
  return {
    areas: seed.areas,
    assets: seed.assets,
    missions: seed.missions,
    positions: [],
    reportIds: [],
    reviewQueue: [],
    entries: [],
    seq: 0,
  };
}
