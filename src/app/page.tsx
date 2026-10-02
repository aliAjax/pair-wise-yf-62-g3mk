'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Alert, Badge, Button, Card, Divider, Grid, Group, List, NumberInput, Progress,
  ScrollArea, Select, SimpleGrid, Stack, Switch, Table, Text, Textarea, TextInput, Title,
} from '@mantine/core';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useMemo, useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { assessAsset } from '@/lib/ledger/ledger';
import type { AssetStatus, LedgerEntry, LedgerState, MissionStatus } from '@/lib/types';
import { SearchMap } from '@/components/SearchMap';

const missionSchema = z.object({
  title: z.string().min(3, '任务名称至少3个字'),
  areaId: z.string().min(1, '请选择搜索区'),
  start: z.string().min(1, '请选择开始时刻'),
  end: z.string().min(1, '请选择结束时刻'),
  requiredEndurance: z.number().min(1, '至少 1 分钟'),
  priority: z.enum(['normal', 'urgent']),
  note: z.string().max(160),
});
type MissionForm = z.infer<typeof missionSchema>;

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
/** 输入框被清空时返回空串而不是抛异常；空窗口在校验中等同于时段不符 */
const safeIso = (v: string) => {
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
};

const AREA_STATUS: Record<string, { label: string; color: string }> = {
  planned: { label: '规划中', color: 'yellow' },
  active: { label: '执行中', color: 'teal' },
  closed: { label: '已关闭', color: 'gray' },
};
const ASSET_STATUS: Record<AssetStatus, { label: string; color: string }> = {
  ready: { label: '可派', color: 'teal' },
  assigned: { label: '任务中', color: 'blue' },
  offline: { label: '离线', color: 'red' },
  returning: { label: '返航', color: 'orange' },
};
const MISSION_STATUS: Record<MissionStatus, { label: string; color: string }> = {
  draft: { label: '草拟', color: 'gray' },
  dispatched: { label: '已派发', color: 'blue' },
  in_progress: { label: '进行中', color: 'teal' },
  completed: { label: '已完成', color: 'green' },
  invalidated: { label: '已失效', color: 'red' },
};
const INVALID_REASON: Record<string, string> = {
  area_unavailable: '区域状态变化，任务退回',
  endurance_exhausted: '续航耗尽，任务退回',
};

/** 账本条目 → 一行中文摘要 */
function describeEntry(e: LedgerEntry, ledger: LedgerState): string {
  const asset = (id: string) => ledger.assets.find((a) => a.id === id)?.name ?? id;
  const area = (id: string) => ledger.areas.find((a) => a.id === id)?.name ?? id;
  const mission = (id: string) => ledger.missions.find((m) => m.id === id)?.title ?? id;
  switch (e.kind) {
    case 'mission_dispatched': return `任务「${mission(e.missionId)}」派发至 ${area(e.areaId)}，占用 ${e.assetIds.map(asset).join('、')}`;
    case 'dispatch_rejected': return `派单「${e.title}」被拒：${e.reasons.map((r) => r.message).join('；')}`;
    case 'mission_started': return `任务「${mission(e.missionId)}」开始执行`;
    case 'mission_completed': return `任务「${mission(e.missionId)}」完成，扫测贡献 ${e.sweptCoverage}%`;
    case 'mission_invalidated': return `任务「${mission(e.missionId)}」失效退回（${INVALID_REASON[e.reason] ?? e.reason}）`;
    case 'area_status_changed': return `搜索区 ${area(e.areaId)}：${AREA_STATUS[e.from].label} → ${AREA_STATUS[e.to].label}`;
    case 'coverage_recomputed': return `${area(e.areaId)} 覆盖率重算为 ${e.coverage}%`;
    case 'position_applied': return `位置报 ${e.reportId} 入账（${asset(e.assetId)}）`;
    case 'position_queued_for_review': return `位置报 ${e.reportId} 与同刻 ${e.keptReportId} 冲突，留待核对`;
    case 'position_duplicate_ignored': return `位置报 ${e.reportId} 编号重复，忽略`;
    case 'review_resolved': return `位置报 ${e.reportId} 核对${e.outcome === 'adopted' ? '采纳' : '作废'}`;
    case 'asset_occupied': return `${asset(e.assetId)} 被「${mission(e.missionId)}」占用（v${e.version}）`;
    case 'occupancy_conflict': return `${asset(e.assetId)} 占用冲突：持 v${e.expectedVersion}，当前 v${e.actualVersion}`;
    case 'asset_released': return `${asset(e.assetId)} 从「${mission(e.missionId)}」释放`;
    case 'asset_status_changed': return `${asset(e.assetId)}：${ASSET_STATUS[e.from].label} → ${ASSET_STATUS[e.to].label}`;
    case 'endurance_consumed': return `${asset(e.assetId)} 续航消耗，剩余 ${e.remainingMinutes} 分钟`;
  }
}

export default function CommandPage() {
  const { ledger, offline, lowBandwidth, pendingReports, notice } = useCommandStore();
  const store = useCommandStore();
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [versionSnapshot, setVersionSnapshot] = useState<Record<string, number>>({});
  const [sweepDraft, setSweepDraft] = useState<Record<string, number>>({});

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<MissionForm>({
    resolver: zodResolver(missionSchema),
    defaultValues: {
      title: '',
      areaId: ledger.areas.find((a) => a.status === 'active')?.id ?? '',
      start: toLocalInput(new Date()),
      end: toLocalInput(new Date(Date.now() + 2 * 3_600_000)),
      requiredEndurance: 60,
      priority: 'urgent',
      note: '',
    },
  });
  const formWindow = { start: safeIso(watch('start')), end: safeIso(watch('end')) };
  const formEndurance = Number(watch('requiredEndurance')) || 0;

  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: lowBandwidth ? false : 60_000,
  });

  /** 选中单位时快照其版本，提交时带上——开具后被他人改动即冲突 */
  const selectAssets = (ids: string[]) => {
    setSelectedAssets(ids);
    setVersionSnapshot(Object.fromEntries(ids.map((id) => [id, ledger.assets.find((a) => a.id === id)?.version ?? 0])));
  };

  const eligibility = useMemo(
    () => Object.fromEntries(ledger.assets.map((a) => [a.id, assessAsset(ledger, a.id, formWindow, formEndurance)])),
    [ledger, formWindow.start, formWindow.end, formEndurance], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const submitMission = (values: MissionForm) => {
    store.dispatchMission({
      title: values.title,
      areaId: values.areaId,
      assetIds: selectedAssets,
      window: { start: safeIso(values.start), end: safeIso(values.end) },
      requiredEnduranceMinutes: values.requiredEndurance,
      priority: values.priority,
      note: values.note,
      expectedVersions: versionSnapshot,
    });
  };

  const activeMissions = ledger.missions.filter((m) => m.status === 'dispatched' || m.status === 'in_progress');
  const invalidatedMissions = ledger.missions.filter((m) => m.status === 'invalidated');
  const completedMissions = ledger.missions.filter((m) => m.status === 'completed');
  const assetName = (id: string) => ledger.assets.find((a) => a.id === id)?.name ?? id;

  return (
    <main className={lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div>
            <Badge color={offline ? 'red' : 'teal'}>{offline ? '离线缓存模式' : '联合指挥在线'}</Badge>
            <Title order={1} className="section-title">海上搜救联合指挥 · 调度账</Title>
            <Text c="dimmed">派单先核区域、时段与续航；一切变更按序入账</Text>
          </div>
          <Group>
            <Switch label="低带宽" checked={lowBandwidth} onChange={store.toggleBandwidth} />
            <Switch label={offline ? `离线（缓存 ${pendingReports.length} 条）` : '模拟离线'} checked={offline} onChange={store.toggleOffline} />
          </Group>
        </Group>

        {notice && (
          <Alert
            color={notice.kind === 'rejected' ? 'red' : notice.kind === 'conflict' ? 'yellow' : 'teal'}
            title={notice.title}
            withCloseButton
            onClose={store.clearNotice}
          >
            <List size="sm">{notice.lines.map((line, i) => <List.Item key={i}>{line}</List.Item>)}</List>
            {notice.kind === 'conflict' && (
              <Button size="compact-xs" mt="xs" variant="light" onClick={() => { selectAssets(selectedAssets); store.clearNotice(); }}>
                按当前版本重新选择
              </Button>
            )}
          </Alert>
        )}

        <SimpleGrid cols={{ base: 1, md: 4 }}>
          {[
            ['活动搜索区', ledger.areas.filter((a) => a.status === 'active').length],
            ['可派单位', ledger.assets.filter((a) => a.status === 'ready' && a.enduranceMinutes > 0).length],
            ['进行中任务', activeMissions.length],
            ['待核对位置', ledger.reviewQueue.length],
          ].map(([label, value]) => (
            <Card key={String(label)} withBorder><Text size="sm" c="dimmed">{label}</Text><Title order={2}>{value}</Title></Card>
          ))}
        </SimpleGrid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Card withBorder>
              <Group justify="space-between">
                <Title order={3}>搜救态势</Title>
                <Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text>
              </Group>
              <SearchMap areas={ledger.areas} assets={ledger.assets} />
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Card withBorder h="100%">
              <Group justify="space-between">
                <Title order={3}>执行单位</Title>
                <Button size="compact-xs" variant="light" onClick={store.injectOfflineBatch}>
                  {offline ? '记录离线位置包' : '模拟离线记录回网'}
                </Button>
              </Group>
              <Stack mt="md">
                {ledger.assets.map((asset) => {
                  const stale = Date.now() - new Date(asset.lastSeen).getTime() > 10 * 60_000;
                  return (
                    <Card key={asset.id} withBorder padding="sm">
                      <Group justify="space-between">
                        <b>{asset.name}</b>
                        <Group gap={6}>
                          <Badge color={ASSET_STATUS[asset.status].color}>{ASSET_STATUS[asset.status].label}</Badge>
                          <Badge variant="outline" color="gray">v{asset.version}</Badge>
                        </Group>
                      </Group>
                      <Text size="xs" c={stale ? 'red' : 'dimmed'}>
                        {stale ? '位置已过期 · ' : ''}{formatDistanceToNow(new Date(asset.lastSeen), { addSuffix: true, locale: zhCN })}
                      </Text>
                      <Text size="xs" c={asset.enduranceMinutes === 0 ? 'red' : 'dimmed'}>
                        剩余续航 {asset.enduranceMinutes} 分钟 · 可用 {asset.availableWindows.map((w) => `${hhmm(w.start)}–${hhmm(w.end)}`).join('，')}
                      </Text>
                      <Group mt="xs" gap={6}>
                        <Button size="compact-xs" variant="default" onClick={() => store.markAssetStatus(asset.id, asset.status === 'offline' ? 'ready' : 'offline')}>
                          {asset.status === 'offline' ? '恢复在线' : '标记失联'}
                        </Button>
                        <Button size="compact-xs" variant="default" onClick={() => store.burnEndurance(asset.id, 60)}>续航 −60</Button>
                        {asset.status === 'ready' && (
                          <Button size="compact-xs" variant="default" color="yellow" onClick={() => store.simulateExternalOccupancy(asset.id)}>
                            他员抢占
                          </Button>
                        )}
                      </Group>
                    </Card>
                  );
                })}
              </Stack>
            </Card>
          </Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <Card withBorder>
              <Title order={3}>派发新任务</Title>
              <Text size="xs" c="dimmed">开具时快照单位版本；提交前被他人占用将拒单并提示重新选择</Text>
              <form onSubmit={handleSubmit(submitMission)}>
                <Stack mt="md">
                  <TextInput label="任务名称" {...register('title')} error={errors.title?.message} />
                  <Select
                    label="搜索区（仅执行中可接单）"
                    value={watch('areaId')}
                    onChange={(v) => v && reset({ ...watch(), areaId: v })}
                    data={ledger.areas.map((a) => ({
                      value: a.id,
                      label: `${a.name}（${AREA_STATUS[a.status].label}）`,
                      disabled: a.status !== 'active',
                    }))}
                  />
                  <Group grow>
                    <TextInput label="开始" type="datetime-local" {...register('start')} error={errors.start?.message} />
                    <TextInput label="结束" type="datetime-local" {...register('end')} error={errors.end?.message} />
                  </Group>
                  <NumberInput
                    label="预计每单位续航消耗（分钟）"
                    value={Number(watch('requiredEndurance'))}
                    min={1}
                    onChange={(v) => reset({ ...watch(), requiredEndurance: Number(v) || 1 })}
                    error={errors.requiredEndurance?.message}
                  />
                  <div>
                    <Text size="sm" fw={500}>调派单位（按当前窗口与续航实时核验）</Text>
                    <Stack gap={4} mt={4}>
                      {ledger.assets.map((asset) => {
                        const reasons = eligibility[asset.id] ?? [];
                        const checked = selectedAssets.includes(asset.id);
                        return (
                          <Group key={asset.id} gap={8} wrap="nowrap">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={reasons.length > 0 && !checked}
                              onChange={() => selectAssets(checked ? selectedAssets.filter((id) => id !== asset.id) : [...selectedAssets, asset.id])}
                            />
                            <Text size="sm">{asset.name} <Text span size="xs" c="dimmed">v{asset.version}</Text></Text>
                            {reasons.length > 0 && <Text size="xs" c="red">{reasons.map((r) => r.message).join('；')}</Text>}
                          </Group>
                        );
                      })}
                    </Stack>
                  </div>
                  <Select
                    label="优先级"
                    value={watch('priority')}
                    onChange={(v) => v && reset({ ...watch(), priority: v as 'normal' | 'urgent' })}
                    data={[{ value: 'urgent', label: '紧急' }, { value: 'normal', label: '常规' }]}
                  />
                  <Textarea label="任务说明" {...register('note')} />
                  <Button type="submit" disabled={selectedAssets.length === 0}>校验并派发</Button>
                </Stack>
              </form>
            </Card>
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 7 }}>
            <Stack>
              <Card withBorder>
                <Title order={3}>搜索区与覆盖率</Title>
                <Table mt="sm">
                  <Table.Thead><Table.Tr><Table.Th>搜索区</Table.Th><Table.Th>状态</Table.Th><Table.Th>覆盖率</Table.Th><Table.Th /></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {ledger.areas.map((area) => (
                      <Table.Tr key={area.id}>
                        <Table.Td>{area.name}</Table.Td>
                        <Table.Td><Badge color={AREA_STATUS[area.status].color}>{AREA_STATUS[area.status].label}</Badge></Table.Td>
                        <Table.Td style={{ width: '38%' }}>
                          <Group gap={8} wrap="nowrap"><Progress value={area.coverage} style={{ flex: 1 }} /><Text size="xs">{area.coverage}%</Text></Group>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            {area.status !== 'active' && <Button size="compact-xs" variant="light" onClick={() => store.changeAreaStatus(area.id, 'active')}>激活</Button>}
                            {area.status === 'active' && <Button size="compact-xs" variant="light" color="gray" onClick={() => store.changeAreaStatus(area.id, 'closed')}>关闭</Button>}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>

              <Card withBorder>
                <Title order={3}>任务单</Title>
                <Stack mt="sm" gap="xs">
                  {activeMissions.map((m) => (
                    <Card key={m.id} withBorder padding="sm">
                      <Group justify="space-between" wrap="nowrap">
                        <div>
                          <b>{m.title}</b> <Badge color={MISSION_STATUS[m.status].color}>{MISSION_STATUS[m.status].label}</Badge>
                          <Text size="xs" c="dimmed">
                            {ledger.areas.find((a) => a.id === m.areaId)?.name} · {m.assetIds.map(assetName).join('、') || '未派单位'} · {hhmm(m.window.start)}–{hhmm(m.window.end)} · 扫测 {m.sweptCoverage}%
                          </Text>
                        </div>
                        <Group gap={6} wrap="nowrap">
                          {m.status === 'dispatched' && <Button size="compact-xs" onClick={() => store.beginMission(m.id)}>开始</Button>}
                          <NumberInput
                            size="xs" w={86} min={0} max={100}
                            value={sweepDraft[m.id] ?? m.sweptCoverage}
                            onChange={(v) => setSweepDraft({ ...sweepDraft, [m.id]: Number(v) || 0 })}
                          />
                          <Button size="compact-xs" color="green" onClick={() => store.finishMission(m.id, sweepDraft[m.id] ?? m.sweptCoverage)}>完成</Button>
                        </Group>
                      </Group>
                    </Card>
                  ))}
                  {activeMissions.length === 0 && <Text size="sm" c="dimmed">暂无进行中任务</Text>}
                  {invalidatedMissions.length > 0 && (
                    <>
                      <Divider label="失效退回" labelPosition="left" />
                      {invalidatedMissions.map((m) => (
                        <Group key={m.id} justify="space-between">
                          <Text size="sm" td="line-through" c="dimmed">{m.title}</Text>
                          <Badge color="red" variant="light">{INVALID_REASON[m.invalidReason ?? ''] ?? '已失效'}</Badge>
                        </Group>
                      ))}
                    </>
                  )}
                  {completedMissions.length > 0 && (
                    <>
                      <Divider label="已完成 · 留档" labelPosition="left" />
                      {completedMissions.map((m) => (
                        <Group key={m.id} justify="space-between">
                          <Text size="sm">{m.title}</Text>
                          <Badge color="green" variant="light">扫测 {m.sweptCoverage}% · 留档</Badge>
                        </Group>
                      ))}
                    </>
                  )}
                </Stack>
              </Card>

              {ledger.reviewQueue.length > 0 && (
                <Card withBorder>
                  <Title order={3}>待核对位置（同刻落选）</Title>
                  <Stack mt="sm" gap="xs">
                    {ledger.reviewQueue.map((item) => (
                      <Group key={item.report.id} justify="space-between">
                        <Text size="sm">
                          {item.report.id} · {assetName(item.report.assetId)} · 观测 {hhmm(item.report.observedAt)} · 与 {item.keptReportId} 同刻，接收较晚
                        </Text>
                        <Group gap={6}>
                          <Button size="compact-xs" variant="light" onClick={() => store.settleReview(item.report.id, 'adopted')}>采纳</Button>
                          <Button size="compact-xs" variant="light" color="gray" onClick={() => store.settleReview(item.report.id, 'dismissed')}>作废</Button>
                        </Group>
                      </Group>
                    ))}
                  </Stack>
                </Card>
              )}
            </Stack>
          </Grid.Col>
        </Grid>

        <Card withBorder>
          <Title order={3}>调度账流水</Title>
          <ScrollArea h={280} mt="sm">
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>#</Table.Th><Table.Th>时刻</Table.Th><Table.Th>经办</Table.Th><Table.Th>账目</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {[...ledger.entries].reverse().slice(0, 40).map((e) => (
                  <Table.Tr key={e.seq}>
                    <Table.Td><Text size="xs" ff="monospace">{e.seq}</Text></Table.Td>
                    <Table.Td><Text size="xs">{new Date(e.at).toLocaleTimeString('zh-CN')}</Text></Table.Td>
                    <Table.Td><Text size="xs">{e.actor}</Text></Table.Td>
                    <Table.Td><Text size="sm">{describeEntry(e, ledger)}</Text></Table.Td>
                  </Table.Tr>
                ))}
                {ledger.entries.length === 0 && <Table.Tr><Table.Td colSpan={4}><Text c="dimmed" size="sm">尚无账目</Text></Table.Td></Table.Tr>}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Card>
      </Stack>
    </main>
  );
}
