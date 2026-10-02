'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  completeMission,
  consumeEndurance,
  dispatch,
  mergeReports,
  occupyAsset,
  openLedger,
  resolveReview,
  setAreaStatus,
  setAssetStatus,
  startMission,
} from './ledger/ledger';
import type {
  AreaStatus,
  AssetStatus,
  DispatchCommand,
  LedgerState,
  PositionReport,
  Rejection,
} from './ledger/types';

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;

/** 种子账：覆盖率由任务扫测贡献派生，初始即自洽 */
const seedLedger = (): LedgerState =>
  openLedger({
    areas: [
      { id: 'area-a', name: 'A区 · 最后目击点', bounds: [121.42, 30.65, 121.68, 30.88], status: 'active', coverage: 68, version: 1 },
      { id: 'area-b', name: 'B区 · 北向漂流', bounds: [121.64, 30.82, 121.96, 31.06], status: 'planned', coverage: 32, version: 1 },
    ],
    assets: [
      {
        id: 'ship-01', name: '海巡071', type: 'ship', status: 'assigned',
        lat: 30.75, lng: 121.55, lastSeen: iso(now - 35_000),
        availableWindows: [{ start: iso(now - 2 * H), end: iso(now + 8 * H) }],
        enduranceMinutes: 240, version: 2,
      },
      {
        id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready',
        lat: 30.82, lng: 121.73, lastSeen: iso(now - 7 * 60_000),
        availableWindows: [{ start: iso(now - 1 * H), end: iso(now + 4 * H) }],
        enduranceMinutes: 180, version: 1,
      },
      {
        id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline',
        lat: 30.69, lng: 121.61, lastSeen: iso(now - 18 * 60_000),
        availableWindows: [{ start: iso(now - 2 * H), end: iso(now + 2 * H) }],
        enduranceMinutes: 45, version: 1,
      },
      {
        id: 'shore-04', name: '岸观察点·芦潮港', type: 'shore', status: 'ready',
        lat: 30.86, lng: 121.83, lastSeen: iso(now - 60_000),
        availableWindows: [{ start: iso(now - 12 * H), end: iso(now + 12 * H) }],
        enduranceMinutes: 720, version: 1,
      },
    ],
    missions: [
      {
        id: 'mission-0', title: 'A区夜间初扫', areaId: 'area-a', assetIds: ['ship-01'],
        status: 'completed', priority: 'normal', note: '夜间目视+探照灯初扫',
        window: { start: iso(now - 10 * H), end: iso(now - 6 * H) },
        requiredEnduranceMinutes: 120, sweptCoverage: 23,
        updatedAt: iso(now - 6 * H), version: 2,
      },
      {
        id: 'mission-1', title: 'A区扇形搜索', areaId: 'area-a', assetIds: ['ship-01', 'drone-03'],
        status: 'in_progress', priority: 'urgent', note: '优先核验橙色漂浮物',
        window: { start: iso(now - 1 * H), end: iso(now + 3 * H) },
        requiredEnduranceMinutes: 120, sweptCoverage: 45,
        updatedAt: iso(now - 6 * 60_000), version: 3,
      },
      {
        id: 'mission-2', title: 'B区预扫（已结案）', areaId: 'area-b', assetIds: ['heli-02'],
        status: 'completed', priority: 'normal', note: '规划前预扫，留档备查',
        window: { start: iso(now - 26 * H), end: iso(now - 22 * H) },
        requiredEnduranceMinutes: 90, sweptCoverage: 32,
        updatedAt: iso(now - 22 * H), version: 2,
      },
    ],
  });

export interface Notice {
  kind: 'rejected' | 'conflict' | 'merged';
  title: string;
  lines: string[];
}

interface CommandState {
  ledger: LedgerState;
  offline: boolean;
  lowBandwidth: boolean;
  pendingReports: PositionReport[];
  notice: Notice | null;
  dispatchMission: (cmd: Omit<DispatchCommand, 'actor'>) => void;
  occupy: (assetId: string, missionId: string, expectedVersion: number) => void;
  changeAreaStatus: (areaId: string, status: AreaStatus) => void;
  markAssetStatus: (assetId: string, status: AssetStatus) => void;
  beginMission: (missionId: string) => void;
  finishMission: (missionId: string, sweptCoverage: number) => void;
  burnEndurance: (assetId: string, minutes: number) => void;
  injectOfflineBatch: () => void;
  settleReview: (reportId: string, outcome: 'adopted' | 'dismissed') => void;
  simulateExternalOccupancy: (assetId: string) => void;
  toggleOffline: () => void;
  toggleBandwidth: () => void;
  clearNotice: () => void;
}

const ACTOR = '值班席';

export const useCommandStore = create<CommandState>()(
  persist(
    (set, get) => ({
      ledger: seedLedger(),
      offline: false,
      lowBandwidth: false,
      pendingReports: [],
      notice: null,

      dispatchMission: (cmd) => {
        const result = dispatch(get().ledger, { ...cmd, actor: ACTOR });
        if (result.ok) {
          set({ ledger: result.state, notice: { kind: 'merged', title: `任务「${cmd.title}」已派并入账`, lines: [`单号 ${result.missionId}`] } });
        } else {
          const conflict = result.reasons.find((r) => r.code === 'version_conflict');
          set({
            ledger: result.state,
            notice: {
              kind: conflict ? 'conflict' : 'rejected',
              title: conflict ? '版本已变化，请重新选择' : '派单被拒，原因如下',
              lines: result.reasons.map((r) => r.message),
            },
          });
        }
      },

      occupy: (assetId, missionId, expectedVersion) => {
        const result = occupyAsset(get().ledger, { assetId, missionId, expectedVersion, actor: ACTOR });
        if (result.ok) {
          set({ ledger: result.state, notice: { kind: 'merged', title: '占用已生效', lines: [`${assetId} 现版本 v${result.version}`] } });
        } else {
          const lines = result.conflict
            ? [`开具时为 v${result.conflict.expectedVersion}，当前已是 v${result.conflict.actualVersion}，请重新选择`]
            : (result.reasons ?? []).map((r) => r.message);
          set({ ledger: result.state, notice: { kind: 'conflict', title: '占用未生效', lines } });
        }
      },

      changeAreaStatus: (areaId, status) =>
        set({ ledger: setAreaStatus(get().ledger, { areaId, status, actor: ACTOR }) }),

      markAssetStatus: (assetId, status) =>
        set({ ledger: setAssetStatus(get().ledger, { assetId, status, actor: ACTOR }) }),

      beginMission: (missionId) =>
        set({ ledger: startMission(get().ledger, { missionId, actor: ACTOR }) }),

      finishMission: (missionId, sweptCoverage) =>
        set({ ledger: completeMission(get().ledger, { missionId, sweptCoverage, actor: ACTOR }) }),

      burnEndurance: (assetId, minutes) =>
        set({ ledger: consumeEndurance(get().ledger, { assetId, minutes, actor: '机载回报' }) }),

      injectOfflineBatch: () => {
        // 预置一组离线记录：同刻两条（接收有先后）、一条更新观测、一条重复编号
        const base = Date.now();
        const t = (min: number) => iso(base + min * 60_000);
        const batch: PositionReport[] = [
          { id: 'off-100', assetId: 'drone-03', observedAt: t(-30), receivedAt: t(-6), lat: 30.7, lng: 121.6 },
          { id: 'off-101', assetId: 'drone-03', observedAt: t(-30), receivedAt: t(-2), lat: 30.705, lng: 121.615 },
          { id: 'off-102', assetId: 'drone-03', observedAt: t(-10), receivedAt: t(-1), lat: 30.715, lng: 121.628 },
          { id: 'off-100', assetId: 'drone-03', observedAt: t(-30), receivedAt: t(-6), lat: 30.7, lng: 121.6 },
        ];
        if (get().offline) {
          // 离线中：先缓存，回网时统一合并
          set((state) => ({
            pendingReports: [...state.pendingReports, ...batch],
            notice: { kind: 'merged', title: '离线记录已缓存', lines: [`待回网合并 ${get().pendingReports.length} 条`] },
          }));
          return;
        }
        const ledger = mergeReports(get().ledger, { reports: batch, actor: '回网合并' });
        set({
          ledger,
          notice: {
            kind: 'merged',
            title: '离线记录已合并入账',
            lines: [
              '同刻两条保留较新接收，另一条留待核对',
              `待核对 ${ledger.reviewQueue.length} 条 · 重复编号已忽略`,
            ],
          },
        });
      },

      settleReview: (reportId, outcome) =>
        set({ ledger: resolveReview(get().ledger, { reportId, outcome, actor: ACTOR }) }),

      simulateExternalOccupancy: (assetId) => {
        // 模拟另一值班员抢先占用：等价于对方终端完成了一次写入
        const ledger = get().ledger;
        const mission = ledger.missions.find((m) => m.status === 'dispatched' || m.status === 'in_progress');
        if (!mission) return;
        const asset = ledger.assets.find((a) => a.id === assetId);
        if (!asset) return;
        const result = occupyAsset(ledger, {
          assetId,
          missionId: mission.id,
          expectedVersion: asset.version,
          actor: '值班员乙（另一终端）',
        });
        if (result.ok) {
          set({
            ledger: result.state,
            notice: { kind: 'conflict', title: `${asset.name} 已被另一值班员占用`, lines: [`版本升至 v${result.version}，你手中的快照已过期`] },
          });
        }
      },

      toggleOffline: () => {
        const goingOnline = get().offline;
        const pending = get().pendingReports;
        if (goingOnline && pending.length > 0) {
          // 回网：缓存的离线记录按编号与观测时刻合并入账
          const ledger = mergeReports(get().ledger, { reports: pending, actor: '回网合并' });
          set({
            offline: false,
            pendingReports: [],
            ledger,
            notice: {
              kind: 'merged',
              title: '已回网，离线记录合并入账',
              lines: [`合并 ${pending.length} 条`, `待核对 ${ledger.reviewQueue.length} 条（同刻落选）`],
            },
          });
          return;
        }
        set((state) => ({ offline: !state.offline }));
      },
      toggleBandwidth: () => set((state) => ({ lowBandwidth: !state.lowBandwidth })),
      clearNotice: () => set({ notice: null }),
    }),
    { name: 'maritime-command-v2' },
  ),
);
