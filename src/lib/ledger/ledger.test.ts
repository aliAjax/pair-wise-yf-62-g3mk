import { describe, expect, it } from 'vitest';
import {
  assessAsset,
  completeMission,
  consumeEndurance,
  dispatch,
  mergeReports,
  occupyAsset,
  openLedger,
  resolveReview,
  setAreaStatus,
  startMission,
  validateDispatch,
} from './ledger';
import type { DispatchCommand, LedgerState, PositionReport } from './types';

const T0 = '2026-10-02T08:00:00.000Z';
const t = (min: number) => new Date(new Date(T0).getTime() + min * 60_000).toISOString();

function fixture(): LedgerState {
  return openLedger({
    areas: [
      { id: 'area-a', name: 'A区', bounds: [121.4, 30.6, 121.7, 30.9], status: 'active', coverage: 0, version: 1 },
      { id: 'area-b', name: 'B区', bounds: [121.6, 30.8, 122.0, 31.1], status: 'closed', coverage: 0, version: 1 },
    ],
    assets: [
      {
        id: 'ship-01', name: '海巡071', type: 'ship', status: 'ready',
        lat: 30.75, lng: 121.55, lastSeen: t(-30),
        availableWindows: [{ start: t(-60), end: t(360) }],
        enduranceMinutes: 240, version: 1,
      },
      {
        id: 'heli-02', name: '救助B-712', type: 'helicopter', status: 'ready',
        lat: 30.82, lng: 121.73, lastSeen: t(-10),
        availableWindows: [{ start: t(-60), end: t(120) }],
        enduranceMinutes: 90, version: 1,
      },
      {
        id: 'drone-03', name: '无人机D-9', type: 'drone', status: 'offline',
        lat: 30.69, lng: 121.61, lastSeen: t(-120),
        availableWindows: [{ start: t(-60), end: t(360) }],
        enduranceMinutes: 45, version: 1,
      },
    ],
    missions: [],
  });
}

function cmd(partial: Partial<DispatchCommand> = {}): DispatchCommand {
  return {
    title: '扇形搜索',
    areaId: 'area-a',
    assetIds: ['ship-01'],
    window: { start: t(0), end: t(120) },
    requiredEnduranceMinutes: 60,
    priority: 'urgent',
    note: '',
    actor: '值班员甲',
    at: T0,
    ...partial,
  };
}

describe('派单校验：区域状态、可用时段、剩余续航', () => {
  it('关闭的搜索区不能接单', () => {
    const state = fixture();
    const result = dispatch(state, cmd({ areaId: 'area-b' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.map((r) => r.code)).toContain('area_not_active');
    // 拒单也入账留痕
    expect(result.state.entries.some((e) => e.kind === 'dispatch_rejected')).toBe(true);
    expect(result.state.missions).toHaveLength(0);
  });

  it('任务窗口超出单位可用时段时拒单', () => {
    const state = fixture();
    const result = dispatch(state, cmd({ assetIds: ['heli-02'], window: { start: t(0), end: t(240) } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.map((r) => r.code)).toContain('window_mismatch');
  });

  it('剩余续航不足时拒单', () => {
    const state = fixture();
    const result = dispatch(state, cmd({ assetIds: ['heli-02'], requiredEnduranceMinutes: 120 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.map((r) => r.code)).toContain('endurance_insufficient');
  });

  it('校验通过则任务与占用一并入账，单位版本 +1', () => {
    const state = fixture();
    const result = dispatch(state, cmd());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mission = result.state.missions[0];
    expect(mission.status).toBe('dispatched');
    const ship = result.state.assets.find((a) => a.id === 'ship-01')!;
    expect(ship.status).toBe('assigned');
    expect(ship.version).toBe(2);
    expect(result.state.entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['mission_dispatched', 'asset_occupied']),
    );
  });

  it('一艘船不能同时挂在两个进行中任务上', () => {
    let state = fixture();
    const first = dispatch(state, cmd({ title: '任务一' }));
    if (!first.ok) throw new Error('首单应成功');
    state = startMission(first.state, { missionId: first.missionId, actor: '值班员甲', at: t(5) });
    const second = dispatch(state, cmd({ title: '任务二', at: t(6) }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      const codes = second.reasons.map((r) => r.code);
      expect(codes).toContain('asset_occupied');
      expect(codes).toContain('asset_unavailable');
    }
    // 仍然只有一个任务挂着这艘船
    const active = second.state.missions.filter((m) => m.status !== 'invalidated' && m.assetIds.includes('ship-01'));
    expect(active).toHaveLength(1);
  });

  it('离线单位不可派', () => {
    const state = fixture();
    expect(assessAsset(state, 'drone-03', { start: t(0), end: t(60) }, 30).map((r) => r.code)).toContain('asset_unavailable');
  });
});

describe('离线记录回网合并', () => {
  const reports: PositionReport[] = [
    // 同一观测时刻两条：r-101 接收更新，应入账；r-100 留待核对
    { id: 'r-100', assetId: 'drone-03', observedAt: t(30), receivedAt: t(35), lat: 30.7, lng: 121.6 },
    { id: 'r-101', assetId: 'drone-03', observedAt: t(30), receivedAt: t(40), lat: 30.71, lng: 121.62 },
    // 更新的观测时刻，决定单位当前位置
    { id: 'r-102', assetId: 'drone-03', observedAt: t(50), receivedAt: t(55), lat: 30.72, lng: 121.63 },
  ];

  it('同刻保留较新接收，另一条留待核对；位置取最新观测', () => {
    const state = mergeReports(fixture(), { reports, actor: '岸台', at: t(60) });
    const drone = state.assets.find((a) => a.id === 'drone-03')!;
    expect([drone.lat, drone.lng]).toEqual([30.72, 121.63]);
    expect(drone.lastSeen).toBe(t(50));
    // 同刻两条中接收较新的 r-101 入账，r-100 留待核对
    expect(state.positions.map((p) => p.id).sort()).toEqual(['r-101', 'r-102']);
    expect(state.reviewQueue).toHaveLength(1);
    expect(state.reviewQueue[0].report.id).toBe('r-100');
    expect(state.reviewQueue[0].keptReportId).toBe('r-101');
    // 离线单位回网后恢复在线
    expect(drone.status).toBe('ready');
  });

  it('合并顺序不影响结果（批内乱序到达）', () => {
    const shuffled = [reports[2], reports[0], reports[1]];
    const state = mergeReports(fixture(), { reports: shuffled, actor: '岸台', at: t(60) });
    expect(state.positions.map((p) => p.id).sort()).toEqual(['r-101', 'r-102']);
    expect(state.reviewQueue.map((r) => r.report.id)).toEqual(['r-100']);
  });

  it('编号重复的报告重传时忽略（幂等）', () => {
    let state = mergeReports(fixture(), { reports, actor: '岸台', at: t(60) });
    const entriesBefore = state.entries.length;
    state = mergeReports(state, { reports: [reports[2]], actor: '岸台', at: t(70) });
    expect(state.entries.length).toBe(entriesBefore + 1);
    expect(state.entries.at(-1)?.kind).toBe('position_duplicate_ignored');
    expect(state.positions).toHaveLength(2);
  });

  it('后到的同刻报告接收更新时，挤掉已入账的并留待核对', () => {
    let state = mergeReports(fixture(), { reports: [reports[0]], actor: '岸台', at: t(36) });
    state = mergeReports(state, { reports: [reports[1]], actor: '岸台', at: t(41) });
    expect(state.positions.map((p) => p.id)).toEqual(['r-101']);
    expect(state.reviewQueue.map((r) => r.report.id)).toEqual(['r-100']);
  });

  it('待核对报告可人工采纳或作废', () => {
    let state = mergeReports(fixture(), { reports, actor: '岸台', at: t(60) });
    state = resolveReview(state, { reportId: 'r-100', outcome: 'adopted', actor: '值班员乙', at: t(61) });
    expect(state.reviewQueue).toHaveLength(0);
    const drone = state.assets.find((a) => a.id === 'drone-03')!;
    expect([drone.lat, drone.lng]).toEqual([30.7, 121.6]);
    expect(state.entries.at(-1)).toMatchObject({ kind: 'review_resolved', outcome: 'adopted' });
  });
});

describe('失效级联与覆盖率', () => {
  function dispatchedFixture() {
    let state = fixture();
    const r1 = dispatch(state, cmd({ title: 'A区一扇形', assetIds: ['ship-01'], at: t(0) }));
    if (!r1.ok) throw new Error('派单应成功');
    state = completeMission(r1.state, { missionId: r1.missionId, sweptCoverage: 40, actor: '值班员甲', at: t(30) });
    const r2 = dispatch(state, cmd({ title: 'A区二扇形', assetIds: ['ship-01'], at: t(31) }));
    if (!r2.ok) throw new Error('第二单应成功');
    return { state: r2.state, activeMissionId: r2.missionId };
  }

  it('区域关闭后：活跃任务失效退回、单位释放、覆盖率重算，已完成任务留档', () => {
    const { state: before, activeMissionId } = dispatchedFixture();
    expect(before.areas.find((a) => a.id === 'area-a')!.coverage).toBe(40);
    const state = setAreaStatus(before, { areaId: 'area-a', status: 'closed', actor: '指挥员', at: t(60) });
    const active = state.missions.find((m) => m.id === activeMissionId)!;
    expect(active.status).toBe('invalidated');
    expect(active.invalidReason).toBe('area_unavailable');
    // 单位被释放回 ready
    expect(state.assets.find((a) => a.id === 'ship-01')!.status).toBe('ready');
    // 覆盖率只剩已完成任务的贡献
    expect(state.areas.find((a) => a.id === 'area-a')!.coverage).toBe(40);
    // 已完成任务留档不动
    const completed = state.missions.find((m) => m.status === 'completed')!;
    expect(completed.sweptCoverage).toBe(40);
    // 级联全程入账
    const kinds = state.entries.map((e) => e.kind);
    expect(kinds).toContain('area_status_changed');
    expect(kinds).toContain('mission_invalidated');
    expect(kinds).toContain('asset_released');
  });

  it('失效任务的扫测贡献从覆盖率中剔除', () => {
    let state = fixture();
    const r = dispatch(state, cmd({ at: t(0) }));
    if (!r.ok) throw new Error('派单应成功');
    state = startMission(r.state, { missionId: r.missionId, actor: '值班员甲', at: t(1) });
    // 任务已有 25% 扫测贡献（通过完成另一任务模拟之外，直接给本任务记贡献）
    state = completeMission(state, { missionId: r.missionId, sweptCoverage: 25, actor: '值班员甲', at: t(20) });
    expect(state.areas[0].coverage).toBe(25);
    // 再派一单并让其失效：贡献为零，覆盖率不变但任务退回
    const r2 = dispatch(state, cmd({ at: t(21) }));
    if (!r2.ok) throw new Error('派单应成功');
    state = setAreaStatus(r2.state, { areaId: 'area-a', status: 'planned', actor: '指挥员', at: t(30) });
    expect(state.missions.find((m) => m.id === r2.missionId)!.status).toBe('invalidated');
    expect(state.areas[0].coverage).toBe(25);
  });

  it('续航耗尽：单位返航、任务失效退回、覆盖率重算', () => {
    let state = fixture();
    const r = dispatch(state, cmd({ assetIds: ['heli-02'], requiredEnduranceMinutes: 90, at: t(0) }));
    if (!r.ok) throw new Error('派单应成功');
    state = consumeEndurance(r.state, { assetId: 'heli-02', minutes: 90, actor: '系统', at: t(90) });
    const heli = state.assets.find((a) => a.id === 'heli-02')!;
    expect(heli.enduranceMinutes).toBe(0);
    expect(heli.status).toBe('returning');
    const mission = state.missions.find((m) => m.id === r.missionId)!;
    expect(mission.status).toBe('invalidated');
    expect(mission.invalidReason).toBe('endurance_exhausted');
    expect(state.entries.map((e) => e.kind)).toContain('endurance_consumed');
  });

  it('续航未耗尽时任务不受影响', () => {
    let state = fixture();
    const r = dispatch(state, cmd({ at: t(0) }));
    if (!r.ok) throw new Error('派单应成功');
    state = consumeEndurance(r.state, { assetId: 'ship-01', minutes: 60, actor: '系统', at: t(60) });
    expect(state.assets.find((a) => a.id === 'ship-01')!.enduranceMinutes).toBe(180);
    expect(state.missions[0].status).toBe('dispatched');
  });
});

describe('乐观并发：同一单位的占用先写入者生效', () => {
  it('后到者看到版本已变化并重新选择', () => {
    let state = fixture();
    const m1 = dispatch(state, cmd({ title: '任务一', assetIds: ['ship-01'], at: t(0) }));
    if (!m1.ok) throw new Error('派单应成功');
    const m2 = dispatch(m1.state, cmd({ title: '任务二', assetIds: [], at: t(1) }));
    // 空单位单也应能建（边界：允许先建单后加人）
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;
    state = m2.state;
    // 直升机当前版本 v1，两名值班员都拿着 v1 提交占用
    const first = occupyAsset(state, { assetId: 'heli-02', missionId: m2.missionId, expectedVersion: 1, actor: '值班员甲', at: t(2) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.version).toBe(2);
    // 后到者仍持 v1，冲突；账上留有冲突记录
    const second = occupyAsset(first.state, { assetId: 'heli-02', missionId: m2.missionId, expectedVersion: 1, actor: '值班员乙', at: t(3) });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.conflict).toEqual({ expectedVersion: 1, actualVersion: 2 });
    expect(second.state.entries.at(-1)).toMatchObject({ kind: 'occupancy_conflict', expectedVersion: 1, actualVersion: 2 });
    // 重新选择（读到 v2 后再提交）即可成功——但此时单位已被占用，业务校验拒绝
    const retry = occupyAsset(second.state, { assetId: 'heli-02', missionId: m2.missionId, expectedVersion: 2, actor: '值班员乙', at: t(4) });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reasons?.map((r) => r.code)).toContain('asset_unavailable');
  });

  it('派单携带版本快照：开具后被他人改动即拒单', () => {
    let state = fixture();
    // 值班员甲开具表单时直升机是 v1；值班员乙先派走了它
    const other = dispatch(state, cmd({ title: '乙的单', assetIds: ['heli-02'], requiredEnduranceMinutes: 60, at: t(0) }));
    if (!other.ok) throw new Error('乙派单应成功');
    state = other.state;
    const mine = dispatch(state, cmd({ title: '甲的单', assetIds: ['heli-02'], at: t(1), expectedVersions: { 'heli-02': 1 } }));
    expect(mine.ok).toBe(false);
    if (!mine.ok) expect(mine.reasons.map((r) => r.code)).toContain('version_conflict');
  });

  it('validateDispatch 汇总全部问题而不是只报第一条', () => {
    const state = fixture();
    const reasons = validateDispatch(state, cmd({ areaId: 'area-b', assetIds: ['drone-03'], requiredEnduranceMinutes: 999 }));
    const codes = reasons.map((r) => r.code);
    expect(codes).toContain('area_not_active');
    expect(codes).toContain('asset_unavailable');
    expect(codes).toContain('endurance_insufficient');
  });
});
