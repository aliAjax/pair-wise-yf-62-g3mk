import type { Mission, PositionReport, RescueAsset, SearchArea } from './types';

/** 任务是否仍占用单位、计入覆盖率 */
export function isMissionActive(mission: Mission): boolean {
  return mission.status === 'dispatched' || mission.status === 'in_progress';
}

/** 任务是否已完结留档（含已完成与失效退回） */
export function isMissionArchived(mission: Mission): boolean {
  return mission.status === 'closed' || mission.status === 'returned';
}

/**
 * 单个任务对搜索区覆盖率的贡献：
 * 任务贡献 18 个百分点，每多一个单位 +12；失效退回与草稿不计。
 */
export function missionContribution(mission: Mission): number {
  if (mission.status === 'returned' || mission.status === 'draft') return 0;
  return 18 + 12 * Math.max(0, mission.assetIds.length - 1);
}

/** 重算覆盖率：覆盖率 = 前期基础 + 在档任务贡献，封顶 100 */
export function recomputeCoverage(areas: SearchArea[], missions: Mission[]): SearchArea[] {
  return areas.map((area) => {
    const contribution = missions
      .filter((mission) => mission.areaId === area.id)
      .reduce((sum, mission) => sum + missionContribution(mission), 0);
    return { ...area, coverage: Math.min(100, Math.round(area.baseCoverage + contribution)) };
  });
}

export interface DispatchCheckInput {
  area: SearchArea | undefined;
  selectedAssets: RescueAsset[];
  missions: Mission[];
  now: number;
}

export type DispatchCheckResult = { ok: true } | { ok: false; error: string };

function fmtWindow(asset: RescueAsset): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${fmt(asset.availableFrom)}-${fmt(asset.availableTo)}`;
}

/**
 * 派单前校验（调度账规则）：
 * 1. 搜索区必须处于执行中（planned/closed 一律不接单）；
 * 2. 单位必须在线、在可用时段内、剩余续航 > 0；
 * 3. 同一单位不能同时挂在两个进行中/已派发任务上。
 */
export function checkDispatch(input: DispatchCheckInput): DispatchCheckResult {
  const { area, selectedAssets, missions, now } = input;
  if (!area) return { ok: false, error: '请选择搜索区' };
  if (area.status !== 'active') {
    return {
      ok: false,
      error: `搜索区「${area.name}」当前为${area.status === 'closed' ? '已关闭' : '规划中'}状态，不能派单`,
    };
  }
  for (const asset of selectedAssets) {
    if (asset.status === 'offline') {
      return { ok: false, error: `单位「${asset.name}」离线，不能派单` };
    }
    const t = now;
    if (t < new Date(asset.availableFrom).getTime() || t > new Date(asset.availableTo).getTime()) {
      return { ok: false, error: `单位「${asset.name}」不在可用时段内（${fmtWindow(asset)}）` };
    }
    if (asset.enduranceRemaining <= 0) {
      return { ok: false, error: `单位「${asset.name}」续航耗尽，不能派单` };
    }
    const busy = missions.find((mission) => isMissionActive(mission) && mission.assetIds.includes(asset.id));
    if (busy) {
      return { ok: false, error: `单位「${asset.name}」已在任务「${busy.title}」执行中，不能重复派单` };
    }
  }
  return { ok: true };
}

/**
 * 离线记录回网合并：
 * 按编号（assetId）+ 观测时刻（observedAt）对账。无同刻记录直接入账；
 * 同刻已有记录时，保留接收时刻较新的一条为接受位置，另一条置为待核对。
 */
export function mergePositionReport(
  reports: PositionReport[],
  incoming: PositionReport,
): { reports: PositionReport[]; accepted: PositionReport; demoted?: PositionReport } {
  const key = (r: PositionReport) =>
    r.assetId === incoming.assetId && r.observedAt === incoming.observedAt && r.status !== 'archived';
  const existing = reports.find(key);
  const acceptedIncoming: PositionReport = { ...incoming, status: 'accepted' };
  if (!existing) {
    return { reports: [...reports, acceptedIncoming], accepted: acceptedIncoming };
  }
  if (new Date(incoming.receivedAt).getTime() >= new Date(existing.receivedAt).getTime()) {
    const demoted: PositionReport = { ...existing, status: 'pending-review' };
    return {
      reports: reports.map((r) => (r.id === existing.id ? demoted : r)).concat(acceptedIncoming),
      accepted: acceptedIncoming,
      demoted,
    };
  }
  return {
    reports: [...reports, { ...incoming, status: 'pending-review' }],
    accepted: existing,
    demoted: incoming,
  };
}

/** 取单位最新一条已接受位置（观测时刻优先，同刻按接收时刻） */
export function latestAcceptedPosition(
  reports: PositionReport[],
  assetId: string,
): PositionReport | undefined {
  return reports
    .filter((r) => r.assetId === assetId && r.status === 'accepted')
    .sort(
      (a, b) =>
        new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime() ||
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    )[0];
}

/** 用位置台账反查各单位最新位置与最后观测时刻 */
export function applyPositions(assets: RescueAsset[], reports: PositionReport[]): RescueAsset[] {
  return assets.map((asset) => {
    const latest = latestAcceptedPosition(reports, asset.id);
    if (!latest) return asset;
    return { ...asset, lat: latest.lat, lng: latest.lng, lastSeen: latest.observedAt };
  });
}

/** 位置是否过期（超过 10 分钟未观测） */
export function isPositionStale(asset: RescueAsset, now: number): boolean {
  return now - new Date(asset.lastSeen).getTime() > 10 * 60_000;
}

/** 可用时段是否覆盖当前时刻 */
export function isInWindow(asset: RescueAsset, now: number): boolean {
  const t = now;
  return t >= new Date(asset.availableFrom).getTime() && t <= new Date(asset.availableTo).getTime();
}
