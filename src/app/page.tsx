'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Grid,
  Group,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
  Timeline,
  Title,
} from '@mantine/core';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { useEffect, useState } from 'react';
import { useCommandStore } from '@/lib/store';
import { isPositionStale } from '@/lib/scheduling';
import { SearchMap } from '@/components/SearchMap';
import { DispatchForm } from '@/components/DispatchForm';
import { AreaPanel } from '@/components/AreaPanel';
import { AssetPanel } from '@/components/AssetPanel';
import { ReviewPanel } from '@/components/ReviewPanel';

const missionBadge = (status: string) => {
  switch (status) {
    case 'dispatched':
      return <Badge color="blue">已派发</Badge>;
    case 'in_progress':
      return <Badge color="teal">进行中</Badge>;
    case 'closed':
      return <Badge color="gray">已完成</Badge>;
    case 'returned':
      return <Badge color="red">已退回</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
};

export default function CommandPage() {
  const state = useCommandStore();
  const [now, setNow] = useState(() => Date.now());
  // 每分钟刷新一次“位置新鲜度”显示
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const brief = useQuery({
    queryKey: ['sea-state'],
    queryFn: async () => ({ wind: '东北风 6级', visibility: '4.2海里', tide: '涨潮' }),
    refetchInterval: state.lowBandwidth ? false : 60_000,
  });

  const staleCount = state.assets.filter((a) => isPositionStale(a, now)).length;
  const pendingCount = state.reports.filter((r) => r.status === 'pending-review').length;
  const returnedCount = state.missions.filter((m) => m.status === 'returned').length;

  return (
    <main className={state.lowBandwidth ? 'low-bandwidth' : ''}>
      <Stack p="xl" gap="lg" maw={1600} mx="auto">
        <Group justify="space-between" align="flex-end">
          <div>
            <Badge color={state.offline ? 'red' : 'teal'}>{state.offline ? '离线缓存模式' : '联合指挥在线'}</Badge>
            <Title order={1} className="section-title">海上搜救联合指挥</Title>
            <Text c="dimmed">搜索区、力量与任务在同一时间线上协同：派单先看区域、时段与续航，离线记录按编号与观测时刻合并入账</Text>
          </div>
          <Group>
            <Switch label="低带宽" checked={state.lowBandwidth} onChange={state.toggleBandwidth} />
            <Switch label="模拟离线" checked={state.offline} onChange={state.toggleOffline} />
          </Group>
        </Group>

        <SimpleGrid cols={{ base: 2, md: 6 }}>
          {[
            ['活动搜索区', state.areas.filter((item) => item.status === 'active').length],
            ['在线单位', state.assets.filter((item) => item.status !== 'offline').length],
            ['进行中任务', state.missions.filter((item) => item.status === 'in_progress' || item.status === 'dispatched').length],
            ['待核对位置', pendingCount],
            ['过期位置', staleCount],
            ['退回任务', returnedCount],
          ].map(([label, value]) => (
            <Card key={String(label)} withBorder>
              <Text size="sm" c="dimmed">{label}</Text>
              <Title order={2}>{value}</Title>
            </Card>
          ))}
        </SimpleGrid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <Card withBorder>
              <Group justify="space-between">
                <Title order={3}>搜救态势</Title>
                <Text size="sm">风况：{brief.data?.wind ?? '读取中'} · 能见度：{brief.data?.visibility ?? '--'}</Text>
              </Group>
              <SearchMap areas={state.areas} assets={state.assets} />
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Card withBorder h="100%">
              <Title order={3}>单位状态</Title>
              <AssetPanel
                assets={state.assets}
                now={now}
                onChangeStatus={state.setAssetStatus}
                onReport={state.reportPosition}
                onEndurance={(id) => state.simulateEndurance(id)}
              />
            </Card>
          </Grid.Col>
        </Grid>

        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, lg: 5 }}>
            <Card withBorder>
              <Title order={3}>派发新任务</Title>
              <DispatchForm
                areas={state.areas}
                assets={state.assets}
                missions={state.missions}
                onDispatch={state.dispatchMission}
                onSimulateConflict={state.simulateConcurrentOccupancy}
              />
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, lg: 7 }}>
            <Stack gap="lg">
              <AreaPanel areas={state.areas} missions={state.missions} onChangeStatus={state.setAreaStatus} />
              <Card withBorder>
                <Title order={3}>任务单</Title>
                <Table mt="md">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>任务</Table.Th>
                      <Table.Th>单位</Table.Th>
                      <Table.Th>状态</Table.Th>
                      <Table.Th>操作</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.missions.map((mission) => (
                      <Table.Tr key={mission.id}>
                        <Table.Td>
                          <Text size="sm" fw={600}>{mission.title}</Text>
                          <Text size="xs" c="dimmed">
                            {state.areas.find((a) => a.id === mission.areaId)?.name ?? mission.areaId}
                            {mission.priority === 'urgent' ? ' · 紧急' : ''}
                          </Text>
                          {mission.status === 'returned' && (
                            <Text size="xs" c="red">退回原因：{mission.returnReason}</Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{mission.assetIds.map((id) => state.assets.find((a) => a.id === id)?.name ?? id).join('、')}</Text>
                        </Table.Td>
                        <Table.Td>{missionBadge(mission.status)}</Table.Td>
                        <Table.Td>
                          <Group gap="xs">
                            {mission.status === 'dispatched' && (
                              <Button size="compact-xs" variant="light" onClick={() => state.setMissionStatus(mission.id, 'in_progress')}>
                                推进
                              </Button>
                            )}
                            {(mission.status === 'dispatched' || mission.status === 'in_progress') && (
                              <Button size="compact-xs" color="teal" variant="light" onClick={() => state.setMissionStatus(mission.id, 'closed')}>
                                完成
                              </Button>
                            )}
                            {mission.status === 'closed' && (
                              <Button size="compact-xs" variant="light" onClick={() => state.setMissionStatus(mission.id, 'in_progress')}>
                                重开
                              </Button>
                            )}
                            {mission.status === 'returned' && (
                              <Text size="xs" c="dimmed">已留档</Text>
                            )}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Card>
            </Stack>
          </Grid.Col>
        </Grid>

        <ReviewPanel
          reports={state.reports}
          outbox={state.outbox}
          offline={state.offline}
          assets={state.assets}
          onMerge={state.mergeOutbox}
          onResolve={state.resolveReview}
          onSeedDemo={state.seedOfflineConflictDemo}
        />

        <Card withBorder>
          <Title order={3}>联合事件时间线</Title>
          <Timeline mt="lg" active={1} bulletSize={18} lineWidth={2}>
            {state.events.slice(0, 12).map((event) => (
              <Timeline.Item
                key={event.id}
                title={`${event.actor} · ${new Date(event.time).toLocaleTimeString()}`}
                bullet={<ThemeIcon size={10} radius="xl" />}
              >
                <Text size="sm">{event.message}</Text>
                <Text size="xs" c="dimmed">{formatDistanceToNow(new Date(event.time), { addSuffix: true, locale: zhCN })}</Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </Card>
      </Stack>
    </main>
  );
}
