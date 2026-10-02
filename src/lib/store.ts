'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AreaStatus,
  AssetStatus,
  EventLog,
  Mission,
  MissionStatus,
  PositionReport,
  RescueAsset,
  SearchArea,
} from './types';
import { applyPositions, checkDispatch, mergePositionReport, recomputeCoverage } from './scheduling';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const seedAreasRaw: SearchArea[] = [
  { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', baseCoverage: 38, coverage: 0 },
  { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', baseCoverage: 32, coverage: 0 },
];

const seedAssets: RescueAsset[] = [
  {
    id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned',
    lat: 30.75, lng: 121.55, lastSeen: iso(-35_000), version: 1,
    availableFrom: iso(-60 * 60_000), availableTo: iso(480 * 60_000),
    enduranceMinutes: 300, enduranceRemaining: 240,
  },
  {
    id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready',
    lat: 30.82, lng: 121.73, lastSeen: iso(-7 * 60_000), version: 1,
    availableFrom: iso(-30 * 60_000), availableTo: iso(300 * 60_000),
    enduranceMinutes: 240, enduranceRemaining: 180,
  },
  {
    id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline',
    lat: 30.69, lng: 121.61, lastSeen: iso(-18 * 60_000), version: 1,
    availableFrom: iso(60 * 60_000), availableTo: iso(240 * 60_000),
    enduranceMinutes: 120, enduranceRemaining: 60,
  },
  {
    id: 'ship-04', name: '海巡072', type: 'ship', status: 'ready',
    lat: 30.91, lng: 121.88, lastSeen: iso(-2 * 60_000), version: 1,
    availableFrom: iso(-120 * 60_000), availableTo: iso(-30 * 60_000),
    enduranceMinutes: 200, enduranceRemaining: 15,
  },
];

const seedMissions: Mission[] = [
  {
    id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'],
    status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物', updatedAt: iso(-6 * 60_000),
  },
];

const initialAreas = recomputeCoverage(seedAreasRaw, seedMissions);

const initialEvents: EventLog[] = [
  { id: 'event-1', time: iso(-15 * 60_000), actor: '指挥员', message: 'A区任务下发，海巡071开始扇形搜索' },
  { id: 'event-2', time: iso(-6 * 60_000), actor: '无人机D-9', message: '链路中断，最后位置已标记为过期' },
  { id: 'event-3', time: iso(-2 * 60_000), actor: '值班员', message: '调度账启用：派单校验区域状态、可用时段、续航与重复占用' },
];

export interface DispatchInput {
  title: string;
  areaId: string;
  assetIds: string[];
  priority: 'normal' | 'urgent';
  note: string;
}

export type DispatchResult =
  | { ok: true; mission: Mission; versions: Record<string, number> }
  | { ok: false; error: string; conflictAssetIds?: string[] };

interface CommandState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  events: EventLog[];
  reports: PositionReport[];
  outbox: PositionReport[];
  offline: boolean;
  lowBandwidth: boolean;
  setAreaStatus: (id: string, status: AreaStatus) => void;
  setAssetStatus: (id: string, status: AssetStatus) => void;
  setMissionStatus: (id: string, status: MissionStatus) => void;
  dispatchMission: (input: DispatchInput, expectedVersions: Record<string, number>) => DispatchResult;
  reportPosition: (assetId: string) => void;
  simulateEndurance: (assetId: string, minutes?: number) => void;
  simulateConcurrentOccupancy: (assetIds: string[]) => void;
  seedOfflineConflictDemo: () => void;
  mergeOutbox: () => number;
  resolveReview: (reportId: string, accept: boolean) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
}

const newEvent = (actor: string, message: string): EventLog => ({
  id: crypto.randomUUID(),
  time: new Date().toISOString(),
  actor,
  message,
});

/** 构造一条位置记录；离线时进回网队列，在线时直接入账 */
function buildReport(asset: RescueAsset, offline: boolean): PositionReport {
  const observedAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    lat: asset.lat + (Math.random() - 0.5) * 0.02,
    lng: asset.lng + (Math.random() - 0.5) * 0.02,
    observedAt,
    receivedAt: offline ? '' : observedAt,
    source: offline ? 'offline' : 'online',
    status: 'accepted',
  };
}

/** 回网合并：按编号 + 观测时刻对账，同刻保留较新接收者，另一条留待核对 */
function mergeOutboxRecords(state: CommandState): {
  reports: PositionReport[];
  assets: RescueAsset[];
  merged: number;
  pending: number;
} {
  let reports = state.reports;
  let pending = 0;
  for (const record of state.outbox) {
    const incoming: PositionReport = { ...record, receivedAt: new Date().toISOString(), status: 'accepted' };
    const result = mergePositionReport(reports, incoming);
    reports = result.reports;
    if (result.demoted) pending += 1;
  }
  return { reports, assets: applyPositions(state.assets, reports), merged: state.outbox.length, pending };
}

/** 区域关闭 / 续航耗尽：相关进行中任务失效退回，释放单位，重算覆盖率 */
function returnAffectedMissions(
  state: CommandState,
  predicate: (mission: Mission) => boolean,
  reason: string,
): { missions: Mission[]; assets: RescueAsset[]; events: EventLog[]; affected: Mission[] } {
  const nowIso = new Date().toISOString();
  const affected = state.missions.filter(
    (mission) => (mission.status === 'dispatched' || mission.status === 'in_progress') && predicate(mission),
  );
  const affectedIds = new Set(affected.map((m) => m.id));
  const releasedAssetIds = new Set(affected.flatMap((m) => m.assetIds));
  const missions = state.missions.map((mission) =>
    affectedIds.has(mission.id)
      ? { ...mission, status: 'returned' as const, returnReason: reason, updatedAt: nowIso }
      : mission,
  );
  const assets = state.assets.map((asset) =>
    releasedAssetIds.has(asset.id) && asset.status === 'assigned'
      ? { ...asset, status: 'ready' as const, version: asset.version + 1 }
      : asset,
  );
  const events = affected.map((mission) =>
    newEvent('指挥员', `任务「${mission.title}」${reason}，已失效退回并释放单位`),
  );
  return { missions, assets, events, affected };
}

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => ({
      areas: initialAreas,
      assets: seedAssets,
      missions: seedMissions,
      events: initialEvents,
      reports: [],
      outbox: [],
      offline: false,
      lowBandwidth: false,

      setAreaStatus: (id, status) => {
        const state = get();
        const area = state.areas.find((a) => a.id === id);
        if (!area || area.status === status) return;
        let missions = state.missions;
        let assets = state.assets;
        let cascadeEvents: EventLog[] = [];
        if (status === 'closed') {
          const result = returnAffectedMissions(
            state,
            (mission) => mission.areaId === id,
            '因搜索区已关闭',
          );
          missions = result.missions;
          assets = result.assets;
          cascadeEvents = result.events;
        }
        const areas = recomputeCoverage(
          state.areas.map((a) => (a.id === id ? { ...a, status } : a)),
          missions,
        );
        const statusLabel = status === 'active' ? '执行中' : status === 'closed' ? '已关闭' : '规划中';
        set({
          areas,
          missions,
          assets,
          events: [
            newEvent('指挥员', `搜索区「${area.name}」状态改为${statusLabel}`),
            ...cascadeEvents,
            ...state.events,
          ],
        });
      },

      setAssetStatus: (id, status) => {
        const state = get();
        const asset = state.assets.find((a) => a.id === id);
        if (!asset) return;
        set({
          assets: state.assets.map((a) =>
            a.id === id ? { ...a, status, version: a.version + 1, lastSeen: new Date().toISOString() } : a,
          ),
          events: [
            newEvent('值班员', `单位「${asset.name}」状态改为${status}，占用版本 +1`),
            ...state.events,
          ],
        });
      },

      setMissionStatus: (id, status) => {
        const state = get();
        const mission = state.missions.find((m) => m.id === id);
        if (!mission) return;
        let assets = state.assets;
        if (status === 'closed' && mission.status !== 'closed') {
          // 完成留档：释放单位，已搜索覆盖率保留
          assets = state.assets.map((asset) =>
            mission.assetIds.includes(asset.id) && asset.status === 'assigned'
              ? { ...asset, status: 'ready' as const, version: asset.version + 1 }
              : asset,
          );
        }
        const missions = state.missions.map((m) =>
          m.id === id ? { ...m, status, updatedAt: new Date().toISOString() } : m,
        );
        const areas = recomputeCoverage(state.areas, missions);
        const statusLabel =
          status === 'closed' ? '完成留档' : status === 'in_progress' ? '推进中' : status;
        set({
          missions,
          assets,
          areas,
          events: [newEvent('指挥员', `任务「${mission.title}」${statusLabel}`), ...state.events],
        });
      },

      dispatchMission: (input, expectedVersions) => {
        const state = get();
        // 乐观锁：先写入生效，后到者看到版本变化后重新选择
        const conflicts = state.assets.filter(
          (asset) =>
            input.assetIds.includes(asset.id) &&
            expectedVersions[asset.id] !== undefined &&
            expectedVersions[asset.id] !== asset.version,
        );
        if (conflicts.length > 0) {
          return {
            ok: false,
            error: `单位「${conflicts.map((c) => c.name).join('、')}」的占用版本已被其他值班员更新，请重新选择单位`,
            conflictAssetIds: conflicts.map((c) => c.id),
          };
        }
        const area = state.areas.find((a) => a.id === input.areaId);
        const selectedAssets = state.assets.filter((a) => input.assetIds.includes(a.id));
        const check = checkDispatch({
          area,
          selectedAssets,
          missions: state.missions,
          now: Date.now(),
        });
        if (!check.ok) return { ok: false, error: check.error };

        const mission: Mission = {
          id: crypto.randomUUID(),
          ...input,
          status: 'dispatched',
          updatedAt: new Date().toISOString(),
        };
        const missions = [mission, ...state.missions];
        const assets = state.assets.map((asset) =>
          input.assetIds.includes(asset.id)
            ? { ...asset, status: 'assigned' as const, version: asset.version + 1 }
            : asset,
        );
        const areas = recomputeCoverage(state.areas, missions);
        set({
          missions,
          assets,
          areas,
          events: [
            newEvent('指挥员', `任务「${mission.title}」已派发至${area?.name}，占用版本 +1`),
            ...state.events,
          ],
        });
        return { ok: true, mission, versions: Object.fromEntries(assets.map((a) => [a.id, a.version])) };
      },

      reportPosition: (assetId) => {
        const state = get();
        const asset = state.assets.find((a) => a.id === assetId);
        if (!asset) return;
        const report = buildReport(asset, state.offline);
        if (state.offline) {
          set({
            outbox: [...state.outbox, report],
            events: [
              newEvent(
                '值班员',
                `离线记录：单位「${asset.name}」位置已入回网队列（观测时刻 ${new Date(report.observedAt).toLocaleTimeString()}）`,
              ),
              ...state.events,
            ],
          });
          return;
        }
        const result = mergePositionReport(state.reports, report);
        set({
          reports: result.reports,
          assets: applyPositions(state.assets, result.reports),
          events: [
            newEvent(
              '值班员',
              `单位「${asset.name}」位置已入账${result.demoted ? '，同时刻旧记录留待核对' : ''}`,
            ),
            ...state.events,
          ],
        });
      },

      simulateEndurance: (assetId, minutes = 30) => {
        const state = get();
        const asset = state.assets.find((a) => a.id === assetId);
        if (!asset) return;
        const remaining = Math.max(0, asset.enduranceRemaining - minutes);
        let assets = state.assets.map((a) =>
          a.id === assetId ? { ...a, enduranceRemaining: remaining } : a,
        );
        let missions = state.missions;
        let cascadeEvents: EventLog[] = [];
        if (remaining <= 0) {
          // 以扣减后的单位状态为基数释放，避免续航值被旧状态覆盖
          const result = returnAffectedMissions(
            { ...state, assets },
            (mission) => mission.assetIds.includes(assetId),
            '因单位续航耗尽',
          );
          missions = result.missions;
          assets = result.assets;
          cascadeEvents = result.events;
        }
        const areas = recomputeCoverage(state.areas, missions);
        set({
          assets,
          missions,
          areas,
          events: [
            ...cascadeEvents,
            newEvent(
              '值班员',
              `单位「${asset.name}」消耗续航 ${minutes} 分钟，剩余 ${Math.max(0, remaining)} 分钟`,
            ),
            ...state.events,
          ],
        });
      },

      simulateConcurrentOccupancy: (assetIds) => {
        const state = get();
        const targets = state.assets.filter((a) => assetIds.includes(a.id));
        if (targets.length === 0) return;
        const assets = state.assets.map((a) =>
          assetIds.includes(a.id)
            ? {
                ...a,
                version: a.version + 1,
                status: a.status === 'offline' ? ('offline' as const) : ('assigned' as const),
              }
            : a,
        );
        set({
          assets,
          events: [
            ...targets.map((t) =>
              newEvent(
                '值班员',
                `另一值班员提交了单位「${t.name}」的占用（版本 ${t.version} → ${t.version + 1}）`,
              ),
            ),
            ...state.events,
          ],
        });
      },

      seedOfflineConflictDemo: () => {
        const state = get();
        const asset = state.assets.find((a) => a.id === 'heli-02') ?? state.assets[0];
        const observedAt = new Date().toISOString();
        const base = {
          id: '',
          assetId: asset.id,
          lat: asset.lat,
          lng: asset.lng,
          observedAt,
          receivedAt: '',
          source: 'offline' as const,
          status: 'accepted' as const,
        };
        set({
          outbox: [
            ...state.outbox,
            { ...base, id: crypto.randomUUID(), lat: asset.lat + 0.004, lng: asset.lng + 0.004 },
            { ...base, id: crypto.randomUUID(), lat: asset.lat - 0.004, lng: asset.lng - 0.004 },
          ],
          events: [
            newEvent('值班员', `离线演练：单位「${asset.name}」两条同时刻位置记录已入回网队列，回网后将按接收时刻对账`),
            ...state.events,
          ],
        });
      },

      mergeOutbox: () => {
        const state = get();
        if (state.outbox.length === 0) return 0;
        const result = mergeOutboxRecords(state);
        set({
          outbox: [],
          reports: result.reports,
          assets: result.assets,
          events: [
            newEvent(
              '值班员',
              `回网合并 ${result.merged} 条离线位置记录：${result.merged - result.pending} 条入账，${result.pending} 条留待核对`,
            ),
            ...state.events,
          ],
        });
        return result.merged;
      },

      resolveReview: (reportId, accept) => {
        const state = get();
        const report = state.reports.find((r) => r.id === reportId);
        if (!report || report.status !== 'pending-review') return;
        const sibling = state.reports.find(
          (r) =>
            r.id !== reportId &&
            r.assetId === report.assetId &&
            r.observedAt === report.observedAt &&
            r.status !== 'archived',
        );
        const reports = state.reports.map((r) => {
          if (accept) {
            if (r.id === reportId) return { ...r, status: 'accepted' as const };
            if (sibling && r.id === sibling.id) return { ...r, status: 'archived' as const };
          } else if (r.id === reportId) {
            return { ...r, status: 'archived' as const };
          }
          return r;
        });
        const assets = applyPositions(state.assets, reports);
        const asset = state.assets.find((a) => a.id === report.assetId);
        set({
          reports,
          assets,
          events: [
            newEvent(
              '值班员',
              accept
                ? `位置核对：采用单位「${asset?.name ?? report.assetId}」${new Date(report.observedAt).toLocaleTimeString()} 的新接收位置，旧记录留档`
                : `位置核对：单位「${asset?.name ?? report.assetId}」${new Date(report.observedAt).toLocaleTimeString()} 的待核对记录留档，保持原位置`,
            ),
            ...state.events,
          ],
        });
      },

      toggleOffline: () => {
        const state = get();
        const goingOffline = !state.offline;
        if (goingOffline) {
          set({
            offline: true,
            events: [newEvent('值班员', '转入离线模式：期间位置记录进入回网队列，派单校验继续生效'), ...state.events],
          });
          return;
        }
        const result = mergeOutboxRecords(state);
        set({
          offline: false,
          outbox: [],
          reports: result.reports,
          assets: result.assets,
          events: [
            newEvent(
              '值班员',
              `恢复在线：回网合并 ${result.merged} 条离线位置记录，${result.pending} 条留待核对`,
            ),
            ...state.events,
          ],
        });
      },

      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
    }),
    { name: 'maritime-command-v2' },
  ),
);
