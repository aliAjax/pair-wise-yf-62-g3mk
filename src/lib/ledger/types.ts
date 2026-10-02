/**
 * 调度账领域类型：搜索区、执行单位、任务单、位置报与账本条目。
 * 所有状态变更都先落成账本条目（LedgerEntry），再折叠出当前状态。
 */

export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline' | 'returning';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'completed' | 'invalidated';
export type AssetType = 'ship' | 'helicopter' | 'drone' | 'shore';

/** 时段，ISO 字符串闭区间 */
export interface TimeWindow {
  start: string;
  end: string;
}

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  /** 覆盖率，派生值：由未失效任务的扫测贡献重算，不直接编辑 */
  coverage: number;
  version: number;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  lat: number;
  lng: number;
  /** 最近一次位置报的观测时刻 */
  lastSeen: string;
  /** 可用时段，派单时任务窗口必须被其中一段完整覆盖 */
  availableWindows: TimeWindow[];
  /** 剩余续航（分钟），归零即返航并触发任务失效 */
  enduranceMinutes: number;
  /** 乐观并发版本：任何占用/释放/状态变更都会 +1 */
  version: number;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  /** 任务执行窗口 */
  window: TimeWindow;
  /** 预计每单位续航消耗（分钟） */
  requiredEnduranceMinutes: number;
  /** 已核实扫测贡献（百分点），失效时从区域覆盖率中剔除 */
  sweptCoverage: number;
  invalidReason?: string;
  updatedAt: string;
  version: number;
}

/** 位置报：离线记录回网后按 id + observedAt 合并入账 */
export interface PositionReport {
  /** 报告编号，重复编号直接忽略（幂等） */
  id: string;
  assetId: string;
  /** 观测时刻 */
  observedAt: string;
  /** 接收时刻；同一观测时刻冲突时，接收较新者入账 */
  receivedAt: string;
  lat: number;
  lng: number;
}

/** 同刻冲突中落选的位置报，留待人工核对 */
export interface ReviewItem {
  report: PositionReport;
  /** 同刻被保留入账的报告编号 */
  keptReportId: string;
  reason: 'same_observed_at_older_receipt';
}

export type InvalidReason = 'area_unavailable' | 'endurance_exhausted';

export type RejectionCode =
  | 'area_unknown'
  | 'area_not_active'
  | 'asset_unknown'
  | 'asset_unavailable'
  | 'asset_occupied'
  | 'window_mismatch'
  | 'endurance_insufficient'
  | 'version_conflict';

export interface Rejection {
  code: RejectionCode;
  message: string;
  assetId?: string;
}

interface EntryBase {
  seq: number;
  at: string;
  actor: string;
}

/** 账本条目：调度账里的一笔 */
export type LedgerEntry = EntryBase &
  (
    | { kind: 'mission_dispatched'; missionId: string; areaId: string; assetIds: string[] }
    | { kind: 'dispatch_rejected'; title: string; reasons: Rejection[] }
    | { kind: 'mission_started'; missionId: string }
    | { kind: 'mission_completed'; missionId: string; sweptCoverage: number }
    | { kind: 'mission_invalidated'; missionId: string; reason: InvalidReason }
    | { kind: 'area_status_changed'; areaId: string; from: AreaStatus; to: AreaStatus }
    | { kind: 'coverage_recomputed'; areaId: string; coverage: number }
    | { kind: 'position_applied'; reportId: string; assetId: string; observedAt: string }
    | { kind: 'position_queued_for_review'; reportId: string; keptReportId: string; assetId: string }
    | { kind: 'position_duplicate_ignored'; reportId: string; assetId: string }
    | { kind: 'review_resolved'; reportId: string; outcome: 'adopted' | 'dismissed' }
    | { kind: 'asset_occupied'; assetId: string; missionId: string; version: number }
    | { kind: 'occupancy_conflict'; assetId: string; missionId: string; expectedVersion: number; actualVersion: number }
    | { kind: 'asset_released'; assetId: string; missionId: string }
    | { kind: 'asset_status_changed'; assetId: string; from: AssetStatus; to: AssetStatus }
    | { kind: 'endurance_consumed'; assetId: string; remainingMinutes: number }
  );

/** 调度账当前状态（由条目折叠维护） */
export interface LedgerState {
  areas: SearchArea[];
  assets: RescueAsset[];
  missions: Mission[];
  /** 已入账的位置报（每个 单位+观测时刻 至多一条） */
  positions: PositionReport[];
  /** 已见报告编号，用于回网重传的幂等去重 */
  reportIds: string[];
  reviewQueue: ReviewItem[];
  entries: LedgerEntry[];
  seq: number;
}

export interface DispatchCommand {
  title: string;
  areaId: string;
  assetIds: string[];
  window: TimeWindow;
  requiredEnduranceMinutes: number;
  priority: 'normal' | 'urgent';
  note: string;
  actor: string;
  at?: string;
  /** 提交人开具表单时看到的单位版本；与当前版本不符即冲突拒单 */
  expectedVersions?: Record<string, number>;
}

export interface OccupyCommand {
  assetId: string;
  missionId: string;
  expectedVersion: number;
  actor: string;
  at?: string;
}

export type OccupancyConflict = { expectedVersion: number; actualVersion: number };
