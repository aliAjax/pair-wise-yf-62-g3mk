'use client';

import { Alert, Badge, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { format } from 'date-fns';
import type { PositionReport, RescueAsset } from '@/lib/types';

interface ReviewPanelProps {
  reports: PositionReport[];
  outbox: PositionReport[];
  offline: boolean;
  assets: RescueAsset[];
  onMerge: () => void;
  onResolve: (reportId: string, accept: boolean) => void;
  onSeedDemo: () => void;
}

const fmtTime = (iso: string) => format(new Date(iso), 'HH:mm:ss');

export function ReviewPanel({ reports, outbox, offline, assets, onMerge, onResolve, onSeedDemo }: ReviewPanelProps) {
  const pending = reports.filter((r) => r.status === 'pending-review');
  const nameOf = (assetId: string) => assets.find((a) => a.id === assetId)?.name ?? assetId;

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Title order={3}>位置核对</Title>
        <Group gap="xs">
          {pending.length > 0 && <Badge color="orange">{pending.length} 条待核对</Badge>}
          {outbox.length > 0 && <Badge color="gray">{outbox.length} 条离线记录待回网</Badge>}
        </Group>
      </Group>

      {pending.length === 0 && outbox.length === 0 && (
        <Text size="sm" c="dimmed" mt="md">
          暂无待核对记录。离线期间上报的位置会在回网后按编号与观测时刻合并入账，同时刻保留较新接收者，另一条留待核对。
        </Text>
      )}

      {pending.length > 0 && (
        <Table mt="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>单位</Table.Th>
              <Table.Th>观测时刻</Table.Th>
              <Table.Th>接收时刻</Table.Th>
              <Table.Th>位置</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {pending.map((report) => (
              <Table.Tr key={report.id}>
                <Table.Td>
                  <Text size="sm" fw={600}>{nameOf(report.assetId)}</Text>
                  <Badge size="xs" color="orange" variant="light">待核对</Badge>
                </Table.Td>
                <Table.Td><Text size="xs">{fmtTime(report.observedAt)}</Text></Table.Td>
                <Table.Td><Text size="xs">{fmtTime(report.receivedAt)}</Text></Table.Td>
                <Table.Td><Text size="xs">{report.lat.toFixed(3)}, {report.lng.toFixed(3)}</Text></Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Button size="compact-xs" color="teal" variant="light" onClick={() => onResolve(report.id, true)}>
                      采用此条
                    </Button>
                    <Button size="compact-xs" color="gray" variant="light" onClick={() => onResolve(report.id, false)}>
                      留档
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {outbox.length > 0 && (
        <Alert mt="md" color="gray" variant="light" title="离线记录队列">
          <Stack gap="xs">
            <Text size="xs">
              {outbox.length} 条记录暂存本机，恢复在线时自动按编号与观测时刻合并入账。
            </Text>
            <Group>
              {!offline && (
                <Button size="compact-xs" variant="light" onClick={onMerge}>
                  立即回网合并
                </Button>
              )}
              <Button size="compact-xs" variant="light" color="grape" onClick={onSeedDemo}>
                演练：同时刻重复记录
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}
    </Card>
  );
}
