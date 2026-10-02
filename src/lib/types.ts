export type AreaStatus = 'planned' | 'active' | 'closed';
export type AssetStatus = 'ready' | 'assigned' | 'offline';
export type MissionStatus = 'draft' | 'dispatched' | 'in_progress' | 'closed' | 'returned';
export type PositionStatus = 'accepted' | 'pending-review' | 'archived';

export interface SearchArea {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  status: AreaStatus;
  /** 前期已完成搜索比例（百分比），覆盖率 = 基础值 + 在档任务贡献，封顶 100 */
  baseCoverage: number;
  coverage: number;
}

export interface PositionReport {
  id: string;
  /** 单位编号 */
  assetId: string;
  lat: number;
  lng: number;
  /** 观测时刻（ISO），与编号共同作为合并键 */
  observedAt: string;
  /** 接收时刻（ISO）：记录实际入账顺序，同时刻以较新接收者为准 */
  receivedAt: string;
  source: 'online' | 'offline';
  status: PositionStatus;
}

export interface RescueAsset {
  id: string;
  name: string;
  type: 'ship' | 'helicopter' | 'drone' | 'shore';
  status: AssetStatus;
  lat: number;
  lng: number;
  lastSeen: string;
  /** 占用版本号：乐观锁，提交时携带读取时的版本，先写入生效 */
  version: number;
  /** 可用时段起（ISO） */
  availableFrom: string;
  /** 可用时段止（ISO） */
  availableTo: string;
  /** 续航总时长（分钟） */
  enduranceMinutes: number;
  /** 剩余续航（分钟），耗尽后相关任务失效退回 */
  enduranceRemaining: number;
}

export interface Mission {
  id: string;
  title: string;
  areaId: string;
  assetIds: string[];
  status: MissionStatus;
  priority: 'normal' | 'urgent';
  note: string;
  updatedAt: string;
  /** 失效退回原因（搜索区关闭 / 续航耗尽） */
  returnReason?: string;
}

export interface EventLog {
  id: string;
  time: string;
  actor: string;
  message: string;
}
